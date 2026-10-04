/**
 * dsh-harness-restart —— host 侧核心重启机制（纯 Node 标准库，无 DSH/Cordis 依赖）。
 *
 * 可独立单测；detached 重新拉起的 helper 也由这里生成，因此不依赖任何已安装包。
 *
 * 两条重启路线（环境自适应，见 {@link relaunchMode}）：
 *   - supervisor 模式（systemd / 容器等「失败重启」语义的监管者）：
 *     插件只负责「体面地死」——写恢复标记 → 留出回传时间 → exit 非零。
 *     监管者按它自己的启动路径原样拉起（systemd Restart=on-failure /
 *     docker restart=always …）。没有任何外部命令参与，也没有新的风险面。
 *   - self 模式（裸跑/无监管者）：detach 一个 node helper，等旧进程退出并
 *     释放端口后，按原 argv + cwd 重新 spawn 一个 `dsh`（Windows 走隐藏控制台）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 刻意使用的退出码：任何非零都会触发监管者的「失败重启」。 */
export const RESTART_EXIT_CODE = 125

/** 进程启动时刻（进程身份的一部分，客户端用它判断「新进程」）。 */
export const PROCESS_STARTED_AT = new Date(performance.timeOrigin).toISOString()

const MARKER_FILENAME = 'dsh-resume.json'
const DEBUG_LOG_FILENAME = 'dsh-harness-restart.log'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function markerPath() {
  return path.join(dshHome(), MARKER_FILENAME)
}

export function debugLog(message) {
  try {
    fs.mkdirSync(dshHome(), { recursive: true })
    fs.appendFileSync(
      path.join(dshHome(), DEBUG_LOG_FILENAME),
      `${new Date().toISOString()} ${message}\n`,
      'utf8',
    )
  } catch { /* best-effort */ }
}

export function debugLogPath() {
  return path.join(dshHome(), DEBUG_LOG_FILENAME)
}

/** 结构化事件日志（设置页「日志」卡片展示用）。 */
export function logEvent(kind, detail) {
  try {
    const record = { time: new Date().toISOString(), event: kind, ...(detail || {}) }
    fs.mkdirSync(dshHome(), { recursive: true })
    fs.appendFileSync(
      path.join(dshHome(), DEBUG_LOG_FILENAME),
      `EVENT ${JSON.stringify(record)}\n`,
      'utf8',
    )
  } catch { /* best-effort */ }
}

/** 读日志尾部（默认 200 行），供设置页展示。 */
export function readLogTail(maxLines = 200) {
  const file = debugLogPath()
  try {
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const split = content === '' ? [] : content.split('\n')
    const trimmed = split[split.length - 1] === '' ? split.slice(0, -1) : split
    return { ok: true, path: file, lines: trimmed.slice(-Math.max(1, Math.floor(maxLines))) }
  } catch (error) {
    return { ok: false, error: String(error && error.message || error), path: file, lines: [] }
  }
}

/** 原子写恢复标记：重启后新进程据此知道要自动继续哪些会话。 */
export function writeResumeMarker(sessionIds, source) {
  try {
    fs.mkdirSync(dshHome(), { recursive: true })
    const tmp = markerPath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({
      sessionIds,
      source,
      restartAt: new Date().toISOString(),
      pid: process.pid,
      exitCode: RESTART_EXIT_CODE,
    }, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, markerPath())
  } catch (error) {
    debugLog(`writeResumeMarker failed: ${String(error)}`)
  }
}

/** 读恢复标记（兼容旧版单会话形式）。 */
export function readResumeMarker() {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(), 'utf8'))
    const record = parsed
    if (Array.isArray(record.sessionIds)) {
      return record.sessionIds.filter((id) => typeof id === 'string' && id !== '')
    }
    if (typeof record.sessionId === 'string' && record.sessionId !== '') {
      return [record.sessionId]
    }
    return []
  } catch {
    return []
  }
}

export function clearResumeMarker() {
  try { fs.unlinkSync(markerPath()) } catch { /* already gone */ }
}

/**
 * 判断当前进程是否被「带失败重启策略的监管者」管理。
 * 返回 'systemd' | 'container' | undefined（undefined = 裸跑，用 self 模式）。
 *
 * systemd 判定：INVOCATION_ID 由 systemd 注入给单元进程，但用户级 scope
 * （手动在终端里跑、tmux 会话等）的 shell 也可能带着它 —— 那种情况下
 * exit 非零并不会被任何 Restart= 拉起。因此还必须确认自身 cgroup 位于
 * /system.slice/（真正的系统单元），否则一律按裸跑处理。
 */
export function supervisorMode() {
  if (process.env.INVOCATION_ID) {
    try {
      const selfCgroup = fs.readFileSync('/proc/self/cgroup', 'utf8')
      if (selfCgroup.includes('/system.slice/')) return 'systemd'
    } catch { /* 非 Linux 或不可读，走后续判断 */ }
  }
  // 容器：进程无法在容器内脱离容器存活，只能靠容器/编排器的重启策略。
  try {
    const comm = fs.readFileSync('/proc/1/comm', 'utf8').trim().toLowerCase()
    const cgroup1 = fs.readFileSync('/proc/1/cgroup', 'utf8')
    if (/docker|containerd|kubepods|\/pods\//i.test(cgroup1)) return 'container'
    if (/^(tini|dumb-init|docker-init|supervisord|runit|s6-)/.test(comm)) return 'container'
  } catch { /* 非 Linux /proc */ }
  return undefined
}

/** 本次重启应走的路线。 */
export function relaunchMode() {
  return supervisorMode() ?? 'self'
}

/** 安排旧进程在 delayMs 后以 RESTART_EXIT_CODE 退出（supervisor 模式用）。 */
export function scheduleRestartExit(delayMs) {
  const ms = Math.max(0, Math.floor(Number(delayMs) || 0))
  setTimeout(() => process.exit(RESTART_EXIT_CODE), ms)
  return ms
}

/** 生成 detached helper 的 JS 源码：等旧进程退出并释放端口后按原参数重新拉起。
 *
 * 改编自 anweat/dsh-restart（MIT, Copyright (c) 2026 anweat）的 relaunch-helper.ts，
 * 含 Windows 隐藏控制台路径；归属见 README「Credits」与 dev 分支 NOTICE。
 */
export function relaunchHelperSource() {
  return String.raw`
function relaunchDirect(execPath, argv, cwd, logOut, logErr) {
  const out = fs.openSync(logOut, 'a')
  const err = fs.openSync(logErr, 'a')
  try {
    const child = spawn(execPath, argv, {
      cwd: cwd,
      detached: true,
      stdio: ['ignore', out, err],
      env: process.env,
      windowsHide: true,
    })
    child.once('error', function () {})
    child.unref()
    return child.pid
  } finally {
    try { fs.closeSync(out) } catch {}
    try { fs.closeSync(err) } catch {}
  }
}

function quoteWindowsArg(value) {
  const arg = String(value)
  if (arg !== '' && !/[\s"]/u.test(arg)) return arg
  let quoted = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === '\\') { backslashes += 1; continue }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    quoted += '\\'.repeat(backslashes) + char
    backslashes = 0
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"'
}

function relaunchHiddenConsole(execPath, argv, cwd, logOut, logErr) {
  const payload = Buffer.from(JSON.stringify({
    filePath: execPath,
    argumentLine: argv.map(quoteWindowsArg).join(' '),
    workingDirectory: cwd,
    logOut: logOut,
    logErr: logErr,
  }), 'utf8').toString('base64')
  const script = "$ErrorActionPreference = 'Stop'\r\n"
    + "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')) | ConvertFrom-Json\r\n"
    + "$params = @{\r\n"
    + "  FilePath = [string]$payload.filePath\r\n"
    + "  WorkingDirectory = [string]$payload.workingDirectory\r\n"
    + "  WindowStyle = 'Hidden'\r\n"
    + "  RedirectStandardOutput = [string]$payload.logOut\r\n"
    + "  RedirectStandardError = [string]$payload.logErr\r\n"
    + "}\r\n"
    + "if ([string]$payload.argumentLine -ne '') { $params.ArgumentList = [string]$payload.argumentLine }\r\n"
    + "Start-Process @params\r\n"
  const psPath = path.join(os.tmpdir(), 'dsh-harness-restart-' + process.pid + '-' + Date.now() + '.ps1')
  fs.writeFileSync(psPath, '\ufeff' + script, 'utf8')
  try {
    const psExe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    )
    const r = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return r.status === 0
  } finally {
    try { fs.unlinkSync(psPath) } catch {}
  }
}

function relaunchDsh(execPath, argv, cwd, logOut, logErr) {
  if (process.platform === 'win32') {
    let ok = false
    try { ok = relaunchHiddenConsole(execPath, argv, cwd, logOut, logErr) } catch { ok = false }
    if (ok) return 'hidden-console'
  }
  relaunchDirect(execPath, argv, cwd, logOut, logErr)
  return 'direct'
}

/* ── 自愈增强：端口释放等待 + 健康探测 + 重试 + supervisor 让位 ── */
const net = require('node:net')
const http = require('node:http')
let TARGET_PORT = 3080
function applyTargetPort(v) { if (typeof v !== 'undefined' && Number(v) > 0) TARGET_PORT = Number(v) }

function probeUp() {
  return new Promise(function (resolve) {
    const sock = net.connect({ host: '127.0.0.1', port: TARGET_PORT, timeout: 600 })
    sock.once('connect', function () { sock.destroy(); resolve(true) })
    sock.once('error', function () { resolve(false) })
    sock.once('timeout', function () { sock.destroy(); resolve(false) })
  })
}
function healthy() {
  return new Promise(function (resolve) {
    const req = http.get({ host: '127.0.0.1', port: TARGET_PORT, path: '/plugins/dsh-harness-restart/status', timeout: 1500 }, function (res) {
      res.resume(); resolve(res.statusCode === 200)
    })
    req.once('error', function () { resolve(false) })
    req.once('timeout', function () { req.destroy(); resolve(false) })
  })
}
const log = function (line) {
  try { fs.appendFileSync(logErr, new Date().toISOString() + ' relaunch: ' + line + '\n', 'utf8') } catch (e) {}
}

async function selfHeal() {
  log('selfHeal start target=' + TARGET_PORT)
  // 阶段 1：等端口空闲（旧进程让出），最长 60s
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const up = await probeUp()
    if (!up) { log('port free after ' + (Date.now() - (deadline - 60000)) + 'ms wait'); break }
    await new Promise(function (r) { setTimeout(r, 700) })
  }
  // 阶段 2：若端口已由**健康的 dsh** 接管（如 systemd 已拉起新实例）→ 让位；
  // 若只是任意 TCP 被占（残留进程等），不算接管，继续自拉起（否则永远起不来）。
  await new Promise(function (r) { setTimeout(r, 1200) })
  const up = await probeUp()
  if (up) {
    const h = await healthy()
    if (h) {
      log('supervisee already healthy (pid took port) → give up')
      try { fs.unlinkSync(selfPath) } catch (e) {}
      process.exit(0)
    }
    log('port busy but not a healthy dsh → keep trying')
  }
  // 阶段 3：自拉起 + 健康探测，最多 3 次
  for (let attempt = 1; attempt <= 3; attempt++) {
    log('spawn attempt ' + attempt)
    let pid = null
    try { pid = relaunchDsh(process.execPath, argv, cwd, logOut, logErr) } catch (e) { log('spawn error: ' + String(e)) }
    const hDeadline = Date.now() + 30000
    let ok = false
    while (Date.now() < hDeadline) {
      if (await healthy()) { ok = true; break }
      await new Promise(function (r) { setTimeout(r, 1500) })
    }
    if (ok) { log('healthy after attempt ' + attempt + ' (pid ' + pid + ')'); try { fs.unlinkSync(selfPath) } catch (e) {}; process.exit(0) }
    log('attempt ' + attempt + ' not healthy; retry')
  }
  log('relaunch-failed: 3 attempts not healthy')
  try { fs.unlinkSync(selfPath) } catch (e) {}
  process.exit(2)
}
`

}

/**
 * self 模式：detach 一个 node helper，在 delayMs+800 后按原 argv/cwd 重新拉起 dsh。
 * helper 与旧进程都在；旧进程退出后 helper 完成 spawn 即自行退出。
 * 返回日志路径等信息，供 UI 展示。
 */
export function spawnSelfRelaunch(delayMs) {
  const argv = [...process.execArgv, ...process.argv.slice(1)]
  const cwd = process.cwd()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const portArgIdx2 = process.argv.findIndex((a) => a === '--port')
  const portForLog = portArgIdx2 >= 0 && process.argv[portArgIdx2 + 1] ? String(process.argv[portArgIdx2 + 1]) : 'default'
  const logOut = path.join(os.tmpdir(), `dsh-harness-restart-${stamp}-${portForLog}.out.log`)
  const logErr = path.join(os.tmpdir(), `dsh-harness-restart-${stamp}-${portForLog}.err.log`)
  const helperPath = path.join(os.tmpdir(), `dsh-harness-restart-helper-${process.pid}-${Date.now()}.cjs`)

  const portArgIdx = argv.findIndex((a) => a === '--port')
  const extractedPort = portArgIdx >= 0 && argv[portArgIdx + 1] ? Number(argv[portArgIdx + 1]) || 3080 : 3080
  const helperCode = [
    "const { spawn, spawnSync } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const os = require('node:os')",
    "const path = require('node:path')",
    relaunchHelperSource(),
    `const argv = ${JSON.stringify(argv)}`,
    `const cwd = ${JSON.stringify(cwd)}`,
    `const logOut = ${JSON.stringify(logOut)}`,
    `const logErr = ${JSON.stringify(logErr)}`,
    `const selfPath = ${JSON.stringify(helperPath)}`,
    `const delay = ${Math.max(0, Math.floor(Number(delayMs) || 0)) + 800}`,
    `const targetPort = ${extractedPort}`,
    'applyTargetPort(targetPort)',
    'setTimeout(() => { selfHeal() }, delay)',
  ].join('\n')

  try {
    fs.writeFileSync(helperPath, helperCode, 'utf8')
    const helper = spawn(process.execPath, [helperPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    })
    helper.unref()
    return { helperPid: helper.pid, logOut, logErr, helperPath, argv, cwd }
  } catch (error) {
    debugLog(`spawnSelfRelaunch failed: ${String(error)}`)
    throw error
  }
}

/** 只读预检：环境事实 + 标记文件可写性（不执行任何重启/命令）。 */
export function preflight() {
  const mode = relaunchMode()
  const checks = {
    ok: true,
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
    cwd: process.cwd(),
    execPath: process.execPath,
    argv: process.argv.slice(1),
    dshHome: dshHome(),
    mode,
    supervisorRestartAvailable: mode !== 'self',
    exitCode: RESTART_EXIT_CODE,
  }
  try {
    fs.mkdirSync(dshHome(), { recursive: true })
    const probe = markerPath() + '.write-probe'
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
    checks.markerWritable = true
  } catch (error) {
    checks.markerWritable = false
    checks.ok = false
    checks.markerError = String(error)
  }
  return checks
}