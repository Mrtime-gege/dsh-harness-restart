/**
 * dsh-harness-restart 离线单测（不接触正在运行的 dsh，不真重启任何进程）。
 *
 * 运行方式（必须指向「运行时加载的那份」插件，因为 @deepseek-ai/* 由宿主解析）：
 *   DSH_RESTART_MODULE=~/.dsh/profiles/web/node_modules/dsh-harness-restart/lib/index.js \
 *     node tests/unit.mjs
 * 默认会自动尝试该默认路径；也支持 `node tests/unit.mjs <module-path>`。
 *
 * 覆盖：日志读写、恢复标记、预检/模式检测、HTTP 守卫与鉴权降级、配置白名单、
 *       二次认证挑战生命周期、以及用「假 ctx」驱动的重启策略引擎
 *       （wait-idle 等待/超时取消、notify 注入与提前/到点、单飞行、取消权限）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const candidates = [
  process.argv[2],
  process.env.DSH_RESTART_MODULE,
  path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-harness-restart', 'lib', 'index.js'),
].filter((value) => typeof value === 'string' && value !== '')

let modulePath = null
for (const candidate of candidates) {
  const resolved = path.resolve(candidate.replace(/^~(?=\/)/, os.homedir()))
  if (fs.existsSync(resolved)) { modulePath = resolved; break }
}
if (modulePath === null) {
  console.error('找不到插件模块；用 DSH_RESTART_MODULE=<…/lib/index.js> 指定')
  process.exit(2)
}

// 测试使用独立 DSH_HOME，绝不碰真实 home（标记/日志都写到这里）。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-unit-'))
process.env.DSH_HOME = TEST_HOME

const plugin = await import(`file://${modulePath}`)
const core = await import(`file://${path.join(path.dirname(modulePath), 'core.js')}`)
const t = plugin.__test

let failures = 0
let checks = 0
function ok(label, condition, detail) {
  checks += 1
  if (!condition) {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
}

/* ── 1. 日志与恢复标记 ─────────────────────────────────────────────── */
core.logEvent('unit-test-event', { note: 'hello' })
core.debugLog('plain line')
const tail = core.readLogTail(50)
ok('log tail ok', tail.ok === true)
ok('log tail path under test home', tail.path.startsWith(TEST_HOME), tail.path)
ok('log tail has EVENT line', tail.lines.some((line) => line.includes('"event":"unit-test-event"')))
ok('log tail has plain line', tail.lines.some((line) => line.includes('plain line')))

core.writeResumeMarker(['s1', 's2'], 'tool')
eq('marker round-trip', core.readResumeMarker(), ['s1', 's2'])
core.clearResumeMarker()
eq('marker cleared', core.readResumeMarker(), [])
fs.writeFileSync(path.join(TEST_HOME, 'dsh-resume.json'), JSON.stringify({ sessionId: 'legacy' }))
eq('marker legacy form', core.readResumeMarker(), ['legacy'])
core.clearResumeMarker()

const preflight = core.preflight()
ok('preflight ok', preflight.ok === true)
ok('preflight marker writable', preflight.markerWritable === true)
ok('preflight mode is a known value', ['systemd', 'container', 'self'].includes(preflight.mode), preflight.mode)
ok('exit code is non-zero', core.RESTART_EXIT_CODE > 0)

/* ── 2. HTTP 守卫与鉴权降级 ────────────────────────────────────────── */
const req = (host, origin, remote) => ({ headers: { host, origin }, socket: { remoteAddress: remote } })
ok('local authority: loopback', t.isLocalAuthority('127.0.0.1:3080') === true)
ok('local authority: LAN + v6', t.isLocalAuthority('192.168.1.9:3080') === true && t.isLocalAuthority('[::1]:3080') === true)
ok('local authority: domain rejected', t.isLocalAuthority('evil.com:3080') === false)
ok('same origin: equal', t.isSameOrigin(req('127.0.0.1:3080', 'http://127.0.0.1:3080')) === true)
ok('same origin: mismatch', t.isSameOrigin(req('127.0.0.1:3080', 'http://evil.com')) === false)

t.setConnection(null)
eq('probe local (no core)', t.authorizeProbe(req('127.0.0.1:3080', 'http://127.0.0.1:3080', '127.0.0.1')), undefined)
eq('probe domain', t.authorizeProbe(req('evil.com', 'http://evil.com', '1.2.3.4')), 403)
eq('restart non-loopback (no core)', t.authorizeRestart(req('192.168.1.9:3080', 'http://192.168.1.9:3080', '192.168.1.9')), 403)
t.setConnection({ requestRejection: () => 403 })
eq('core 403 honored on probe', t.authorizeProbe(req('127.0.0.1:3080', 'http://127.0.0.1:3080', '127.0.0.1')), 403)
t.setConnection({ requestRejection: () => 401 })
eq('core 401 allows local recovery', t.authorizeProbe(req('127.0.0.1:3080', 'http://127.0.0.1:3080', '127.0.0.1')), undefined)
eq('core 401 rejects domain recovery', t.authorizeProbe(req('evil.com', 'http://evil.com', '1.2.3.4')), 403)
eq('core 401 blocks restart', t.authorizeRestart(req('127.0.0.1:3080', 'http://127.0.0.1:3080', '127.0.0.1')), 401)
t.setConnection({ requestRejection: () => undefined })
eq('core allow restart', t.authorizeRestart(req('127.0.0.1:3080', 'http://127.0.0.1:3080', '127.0.0.1')), undefined)
t.setConnection({ requestRejection: () => { throw new Error('boom') } })
eq('core throw falls back to local', t.authorizeProbe(req('127.0.0.1:3080', 'http://127.0.0.1:3080', '127.0.0.1')), undefined)
t.setConnection(null)

/* ── 3. 配置严格校验（越界报错，绝不钳制）─────────────────────────── */
const vp = (patch) => JSON.stringify(t.validatePatch(patch))
eq('patch: keep valid', vp({ restartPolicy: 'notify', aiRestartChallenge: false }), JSON.stringify({ ok: true, values: { restartPolicy: 'notify', aiRestartChallenge: false } }))
ok('patch: bad policy errors', vp({ restartPolicy: 'nuke' }).includes('restartPolicy'))
ok('patch: unknown keys error', vp({ evil: 1, requireToolConfirm: true }).includes('未知配置项'))
ok('patch: negative wait time errors', vp({ waitIdleTimeoutMs: -1 }).includes('超出范围'))
ok('patch: below-3min notify errors (no clamping)', vp({ notifyWaitMs: 30000 }).includes('超出范围'))
ok('patch: below-3min wait-idle errors (no clamping)', vp({ waitIdleTimeoutMs: 1000 }).includes('超出范围'))
ok('patch: absurd delay errors', vp({ restartDelayMs: 999999999 }).includes('超出范围'))
eq('patch: valid within range', vp({ notifyWaitMs: 300000, restartDelayMs: 5000 }), JSON.stringify({ ok: true, values: { notifyWaitMs: 300000, restartDelayMs: 5000 } }))
eq('patch: text trimmed', vp({ continuePrompt: 'x  ', notifyPrompt: 'y' }), JSON.stringify({ ok: true, values: { continuePrompt: 'x', notifyPrompt: 'y' } }))
ok('patch: empty text errors', vp({ notifyPrompt: '' }).includes('非空字符串'))
ok('patch: non-bool errors', vp({ aiRestartEnabled: 'yes' }).includes('布尔'))

/* ── 4. 二次认证挑战 ───────────────────────────────────────────────── */
const token = t.issueChallenge()
ok('challenge is 16 chars', typeof token === 'string' && token.length === 16, token)
ok('challenge is hex', /^[0-9a-f]{16}$/.test(token), token)
ok('challenge active', t.challengeState() === 'active')
eq('challenge mismatch', t.consumeChallenge('0000000000000000'), 'mismatch')
ok('challenge survives mismatch (still active)', t.challengeState() === 'active')
eq('challenge matched', t.consumeChallenge(token), 'matched')
eq('challenge consumed once', t.consumeChallenge(token), 'missing')
t.setChallenge({ token: 'aaaaaaaaaaaaaaaa', createdAt: Date.now() - 6 * 60 * 1000 })
eq('challenge expired', t.consumeChallenge('aaaaaaaaaaaaaaaa'), 'expired')
t.setChallenge(null)
const guidance = t.challengeGuidance('0123456789abcdef', 'wait-idle')
ok('guidance mentions token', guidance.includes('0123456789abcdef'))
ok('guidance tells ignore-if-mistaken', guidance.includes('误判') || guidance.includes('忽略'))
ok('guidance binds policy', guidance.includes('wait-idle'))
ok('guidance requires consistency', guidance.includes('完全一致') || guidance.includes('一致'))

/* ── 5. 策略引擎（假 ctx）───────────────────────────────────────────── */
function fakeCtx(agents, disposers = []) {
  return {
    agents: { roots: () => agents, get: (id) => agents.find((agent) => agent.id === id) },
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  }
}
function agent(id, status, spy) {
  return { id, status, followup: (message) => { if (spy) spy(message) } }
}

t.suppressFinalize(true)
const disposers = []

// 5.1 now 策略：直接进入 restarting
{
  t.setPendingPlan(null)
  const ctx = fakeCtx([], disposers)
  const result = await t.requestRestart(ctx, 'button', { policy: 'now', delayMs: 1 })
  eq('now: phase', result.phase, 'restarting')
  eq('now: relaunch suppressed', result.relaunch, 'suppressed-test')
  t.setPendingPlan(null)
}

// 5.2 wait-idle：有会话在跑 → 等待；转空闲 → 落地
{
  t.setPendingPlan(null)
  let running = true
  const ctx = {
    agents: { roots: () => (running ? [agent('s1', 'running')] : [agent('s1', 'idle')]), get: () => undefined },
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  }
  const started = await t.requestRestart(ctx, 'tool', { policy: 'wait-idle' })
  eq('wait-idle: waiting', started.phase, 'waiting')
  t.setPendingPlan({ policy: 'wait-idle', source: 'tool', startedAt: Date.now(), deadline: Date.now() + 60000, noticeSent: false, phase: 'waiting' })
  await t.tickWaiting(ctx)
  ok('wait-idle: still waiting while running', t.challengeState !== undefined && t.idleSnapshot(ctx).running === 1)
  eq('wait-idle: pending preserved', t.cancelPending(false).ok, true) // 清场
  running = false
  t.setPendingPlan({ policy: 'wait-idle', source: 'tool', startedAt: Date.now(), deadline: Date.now() + 60000, noticeSent: false, phase: 'waiting' })
  await t.tickWaiting(ctx)
  eq('wait-idle: finalized when idle', t.idleSnapshot(ctx).running, 0)
  eq('wait-idle: cancel after finalize fails', t.cancelPending(false).ok, false)
  t.setPendingPlan(null)
}

// 5.3 wait-idle 超时 → 取消
{
  t.setPendingPlan({ policy: 'wait-idle', source: 'tool', startedAt: Date.now() - 1000, deadline: Date.now() - 1, noticeSent: false, phase: 'waiting' })
  const ctx = fakeCtx([agent('s1', 'running')], disposers)
  await t.tickWaiting(ctx)
  eq('wait-idle timeout: cancelled', t.cancelPending(false).ok, false)
}

// 5.4 notify：注入一次、{minutes} 替换、到点落地
{
  t.setPendingPlan(null)
  const sent = []
  const ctx = fakeCtx([agent('s1', 'running', (message) => sent.push(message))], disposers)
  t.setPendingPlan({ policy: 'notify', source: 'tool', startedAt: Date.now(), deadline: Date.now() + 60000, noticeSent: false, phase: 'waiting' })
  await t.tickWaiting(ctx)
  eq('notify: one message injected', sent.length, 1)
  t.setPendingPlan({ policy: 'notify', source: 'tool', startedAt: Date.now(), deadline: Date.now() + 60000, noticeSent: true, phase: 'waiting' })
  await t.tickWaiting(ctx)
  eq('notify: no duplicate injection', sent.length, 1)
  const text = sent.length > 0 ? JSON.stringify(sent[0]) : ''
  ok('notify: {minutes} replaced', !text.includes('{minutes}') && /分钟后重启/.test(text), text.slice(0, 120))
  t.setPendingPlan({ policy: 'notify', source: 'tool', startedAt: Date.now() - 1000, deadline: Date.now() - 1, noticeSent: true, phase: 'waiting' })
  await t.tickWaiting(ctx)
  eq('notify: finalized on deadline', t.cancelPending(false).ok, false)
  t.setPendingPlan(null)
}

// 5.5 单飞行
{
  t.setPendingPlan({ policy: 'wait-idle', source: 'button', startedAt: Date.now(), deadline: Date.now() + 60000, noticeSent: false, phase: 'waiting' })
  const ctx = fakeCtx([], disposers)
  const second = await t.requestRestart(ctx, 'tool', { policy: 'now' })
  eq('single-flight: second rejected', second.ok, false)
  t.setPendingPlan(null)
}

// 5.6 取消权限：AI 只能取消自己发起的
{
  t.setPendingPlan({ policy: 'wait-idle', source: 'button', startedAt: Date.now(), deadline: Date.now() + 60000, noticeSent: false, phase: 'waiting' })
  eq('cancel: AI cannot cancel button restart', t.cancelPending(true).ok, false)
  eq('cancel: page can cancel button restart', t.cancelPending(false).ok, true)

  t.setPendingPlan({ policy: 'notify', source: 'tool', startedAt: Date.now(), deadline: Date.now() + 60000, noticeSent: true, phase: 'waiting' })
  eq('cancel: AI cancels own restart', t.cancelPending(true).ok, true)
  eq('cancel: nothing pending', t.cancelPending(false).ok, false)
}


/* ── 6. AI 禁用立即重启 + 倒计时下限 3 分钟 ─────────────────────────── */
{
  t.setPendingPlan(null)
  const ctx0 = fakeCtx([], disposers)
  const denied = await t.requestRestart(ctx0, 'tool', { policy: 'now' })
  eq('ai now denied', denied.ok, false)
  ok('ai now denied message', /立即重启/.test(denied.error || ''))

  // AI wait-idle：floor 未到（即便已空闲）不落地
  t.setPendingPlan({ policy: 'wait-idle', source: 'tool', startedAt: Date.now(), deadline: Date.now() + 600000, floor: Date.now() + 60000, noticeSent: false, phase: 'waiting' })
  await t.tickWaiting(fakeCtx([], disposers))
  eq('ai floor unreached: still waiting', t.cancelPending(false).ok, true)

  // AI wait-idle：floor 已到且空闲 → 落地
  t.setPendingPlan({ policy: 'wait-idle', source: 'tool', startedAt: Date.now(), deadline: Date.now() + 600000, floor: Date.now() - 1000, noticeSent: false, phase: 'waiting' })
  await t.tickWaiting(fakeCtx([], disposers))
  eq('ai floor reached: finalized', t.cancelPending(false).ok, false)

  // 页面 wait-idle：无 floor，空闲即落地
  t.setPendingPlan({ policy: 'wait-idle', source: 'button', startedAt: Date.now(), deadline: Date.now() + 600000, floor: 0, noticeSent: false, phase: 'waiting' })
  await t.tickWaiting(fakeCtx([], disposers))
  eq('page wait-idle finalizes at once', t.cancelPending(false).ok, false)

  // AI notify：floor 未到不因空闲而提前
  t.setPendingPlan({ policy: 'notify', source: 'tool', startedAt: Date.now(), deadline: Date.now() + 300000, floor: Date.now() + 60000, noticeSent: true, phase: 'waiting' })
  await t.tickWaiting(fakeCtx([], disposers))
  eq('ai notify floor unreached: still waiting', t.cancelPending(false).ok, true)

  // 请求级 floor：tool 来源的等待计划 deadline ≥ now+3min
  const started = await t.requestRestart(fakeCtx([], disposers), 'tool', { policy: 'wait-idle' })
  ok('ai request floor >= 3min', started.etaMs >= 180000 - 5000, started.etaMs)
  t.setPendingPlan(null)
  t.suppressFinalize(false)
}


/* ── 7. requestRestart 参数严格校验（越界报错）───────────────────────── */
{
  t.setPendingPlan(null)
  const ctx7 = fakeCtx([], disposers)
  eq('restart: bad policy errors', (await t.requestRestart(ctx7, 'tool', { policy: 'nuke' })).ok, false)
  eq('restart: delayMs over max errors', (await t.requestRestart(ctx7, 'tool', { policy: 'wait-idle', delayMs: 999999999 })).ok, false)
  eq('restart: delayMs negative errors', (await t.requestRestart(ctx7, 'tool', { policy: 'wait-idle', delayMs: -5 })).ok, false)
  const okDelay = await t.requestRestart(ctx7, 'tool', { policy: 'wait-idle', delayMs: 5000 })
  eq('restart: valid delayMs accepted', okDelay.ok, true)
  t.setPendingPlan(null)
}


/* ── 8. verifyAiRestart：认证串 + 策略一致性 ───────────────────────────── */
{
  const cfg = { aiRestartChallenge: true }
  t.setChallenge(null)
  const first = t.verifyAiRestart(cfg, undefined, 'wait-idle')
  ok('verify: first issues challenge', first.needConfirm === true && first.confirmToken.length === 16)
  ok('verify: guidance mentions policy', (first.message || '').includes('wait-idle'))

  const second = t.verifyAiRestart(cfg, first.confirmToken, 'notify')
  ok('verify: policy change denied', second.needConfirm === true && (second.message || '').includes('不一致'))
  eq('verify: challenge kept after policy mismatch', second.confirmToken, first.confirmToken)

  const third = t.verifyAiRestart(cfg, first.confirmToken, 'wait-idle')
  eq('verify: consistent policy passes', third.ok, true)

  const again = t.verifyAiRestart(cfg, undefined, 'wait-idle')
  ok('verify: consumed -> fresh challenge', again.needConfirm === true)

  t.setChallenge(null)
  const f2 = t.verifyAiRestart(cfg, undefined, undefined)
  ok('verify: no-policy first', f2.needConfirm === true)
  const s2 = t.verifyAiRestart(cfg, f2.confirmToken, undefined)
  eq('verify: consistent no-policy passes', s2.ok, true)

  eq('verify: challenge disabled passes', t.verifyAiRestart({ aiRestartChallenge: false }, undefined, 'notify').ok, true)
  t.setChallenge(null)
}

t.suppressFinalize(false)
for (const dispose of disposers) {
  try { dispose() } catch { /* ignore */ }
}

/* ── 汇总 ──────────────────────────────────────────────────────────── */
fs.rmSync(TEST_HOME, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} assertions passed${failures === 0 ? ' — ALL GREEN' : ` — ${failures} FAILURES`}`)
process.exit(failures === 0 ? 0 : 1)
