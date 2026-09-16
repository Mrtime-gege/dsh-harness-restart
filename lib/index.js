/**
 * dsh-harness-restart —— host 半（host half）
 *
 * 职责：
 *   1. 模型工具 `dsh_restart`（受设置开关 `aiRestartEnabled` 限制 + confirm 守卫）
 *   2. `/restart` 斜杠命令
 *   3. 同源 HTTP 路由（本机/私有网段 + 同源守卫，见「HTTP 守卫与凭证交接」）：
 *        GET  /plugins/dsh-harness-restart/status    身份 + 策略状态 + 空闲快照 + 新凭证 url
 *        GET  /plugins/dsh-harness-restart/config    当前配置
 *        POST /plugins/dsh-harness-restart/config    改写配置（写进 settings.yaml）
 *        POST /plugins/dsh-harness-restart/restart   按策略安排/开始重启
 *        POST /plugins/dsh-harness-restart/cancel    取消等待中的重启
 *        GET  /plugins/dsh-harness-restart/check     只读预检
 *   4. 重启策略：
 *        now       立即重启（写恢复标记 → exit 非零 / detach helper）
 *        wait-idle 等全部会话空闲（阻塞/结束）后重启，超时取消
 *        notify    先向全部活跃会话注入提示词，等待 N 分钟（全部空闲可提前）后重启
 *   5. 重启前把「所有未完成会话」（进行中 turn ∪ 有活动 goal）写入恢复标记；
 *      新进程启动时按标记自动继续（agent live → followup；冷会话 → sessionController.prompt）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import {
  PROCESS_STARTED_AT,
  relaunchMode,
  preflight,
  scheduleRestartExit,
  spawnSelfRelaunch,
  writeResumeMarker,
  readResumeMarker,
  clearResumeMarker,
  debugLog,
  logEvent,
  readLogTail,
  debugLogPath,
} from './core.js'

export const Config = z.object({
  continuePrompt: z.string().default('【DSH 系统】已重启完成。请检查本会话是否有未完成的工作或活动中的 goal：如有，先恢复/继续它，完成后再向用户简要报告恢复结果。')
    .description('重启后向每个未完成会话注入的继续提示。统一格式：以【DSH 系统】开头。'),
  restartDelayMs: z.number().default(2000).min(0).max(60000)
    .description('旧进程退出前等待的毫秒数（0–60000，给当前结果留出落盘回传时间）。'),
  aiRestartChallenge: z.boolean().default(true)
    .description('AI 发起重启是否需要「二次认证」：首次调用只返回 16 位随机认证串与引导，二次调用携带并匹配该串后才真正重启。'),
  aiRestartEnabled: z.boolean().default(true)
    .description('是否允许 AI 使用重启工具（关闭后 dsh_restart 一律拒绝；设置页按钮不受影响）。'),
  restartPolicy: z.string().default('now')
    .description('默认重启策略：now 立即 / wait-idle 等全部会话空闲 / notify 先通知再等待。'),
  waitIdleTimeoutMs: z.number().default(600000).min(180000).max(86400000)
    .description('wait-idle 策略的最长等待毫秒数（180000–86400000），超时则取消重启。'),
  notifyPrompt: z.string().default('【DSH 系统】DSH 将在约 {minutes} 分钟后重启。请尽快收尾当前工作、不要发起新的长任务；重启后未完成的工作会自动继续。')
    .description('notify 策略注入给会话的提示词，{minutes} 会替换为等待分钟数。统一格式：以【DSH 系统】开头。'),
  notifyWaitMs: z.number().default(300000).min(180000).max(86400000)
    .description('notify 策略在注入提示词后等待的毫秒数（180000–86400000）。'),
  notifyRestartWhenIdle: z.boolean().default(true)
    .description('notify 策略下若全部会话提前空闲，是否立刻重启（不必等满）。'),
})

export const name = 'dsh-harness-restart'
export const inject = ['tools', 'agents', 'webServer']

const POLICY_VALUES = new Set(['now', 'wait-idle', 'notify'])
const CONFIG_KEYS = new Set([
  'continuePrompt', 'restartDelayMs', 'aiRestartChallenge',
  'aiRestartEnabled', 'restartPolicy', 'waitIdleTimeoutMs', 'notifyPrompt', 'notifyWaitMs', 'notifyRestartWhenIdle',
])

const DEFAULTS = {
  continuePrompt: '【DSH 系统】已重启完成。请检查本会话是否有未完成的工作或活动中的 goal：如有，先恢复/继续它，完成后再向用户简要报告恢复结果。',
  restartDelayMs: 2000,
  aiRestartChallenge: true,
  aiRestartEnabled: true,
  restartPolicy: 'now',
  waitIdleTimeoutMs: 600000,
  notifyPrompt: '【DSH 系统】DSH 将在约 {minutes} 分钟后重启。请尽快收尾当前工作、不要发起新的长任务；重启后未完成的工作会自动继续。',
  notifyWaitMs: 300000,
  notifyRestartWhenIdle: true,
}

/** 等待中的重启计划（单飞行）；null = 当前没有等待。 */
let pendingPlan = null
/** AI 重启的二次认证挑战（单活跃、一次性、带过期）；null = 当前没有挑战。 */
let pendingChallenge = null
/** 挑战有效期（毫秒）。 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000
/** AI 发起等待型重启的最短倒计时（毫秒）：立即重启对 AI 禁用，等待类至少 3 分钟。 */
const AI_MIN_COUNTDOWN_MS = 3 * 60 * 1000
/** 各数值参数合法范围（毫秒）。越界一律报错，绝不静默钳制。 */
const RANGES = {
  restartDelayMs: { min: 0, max: 60 * 1000 },
  waitIdleTimeoutMs: { min: AI_MIN_COUNTDOWN_MS, max: 24 * 3600 * 1000 },
  notifyWaitMs: { min: AI_MIN_COUNTDOWN_MS, max: 24 * 3600 * 1000 },
}
/** 最近一次策略结局，供设置页显示。 */
let lastOutcome = null
/** 配置源句柄（设置缝 attach 后指向最新值）。 */
let configSource = null
/** 连接服务句柄（可能在插件之后才挂载）。 */
let connectionRef = null
/** 测试钩子：置真时 finalizeRestart 不真正安排退出/自拉起（仅供离线单测）。 */
let suppressFinalize = false

function resolveConfig(config) {
  return { ...DEFAULTS, ...(config || {}) }
}

/* ── AI 二次认证挑战 ──────────────────────────────────────────────────────
 *
 * 目的：让 AI 的每次重启都必须跨两次调用完成，从而过滤「顺手/误判」式的重启。
 * 规则：单活跃挑战（新的首调用会顶掉旧的）、一次性消费、5 分钟过期、
 * 16 位随机串（8 字节 → hex），从不写进日志明文。
 */

function issueChallenge(policy) {
  const token = randomBytes(8).toString('hex')
  pendingChallenge = { token, createdAt: Date.now(), policy: policy === undefined ? undefined : policy }
  return token
}

function challengeState() {
  if (pendingChallenge === null) return 'none'
  if (Date.now() - pendingChallenge.createdAt > CHALLENGE_TTL_MS) return 'expired'
  return 'active'
}

/** 校验并消费挑战；返回 'matched' | 'missing' | 'mismatch' | 'expired'。 */
function consumeChallenge(token) {
  if (pendingChallenge === null) return 'missing'
  if (Date.now() - pendingChallenge.createdAt > CHALLENGE_TTL_MS) {
    pendingChallenge = null
    return 'expired'
  }
  if (typeof token !== 'string' || token === '' || token !== pendingChallenge.token) return 'mismatch'
  pendingChallenge = null
  return 'matched'
}

/** 首次调用返回给 AI 的引导文案（工具描述里刻意不写流程）。 */
function challengeGuidance(token, policy) {
  return [
    '本次调用未执行重启。',
    '如果这次调用是误判或误触，请忽略本消息、不要继续，也不要向用户复述本消息。',
    '如果确定需要重启 DeepSeek Harness，请再次调用本工具，并保持以下参数与本次完全一致：',
    `confirmToken = ${token}`,
    policy === undefined
      ? 'policy = （第二次调用同样不要传 policy）'
      : `policy = ${policy}`,
    '（认证串 16 位、只能使用一次、5 分钟内有效；第二次传入的 policy 与首次不一致会被拒绝。再次调用才会真正按策略重启。）',
  ].join('\n')
}

/** 认证串正确但 policy 与首次不一致时的拒绝文案。 */
function policyMismatchGuidance(token, firstPolicy, givenPolicy) {
  return [
    '认证串有效，但本次传入的 policy 与首次发起时不一致，未执行重启。',
    `首次发起：policy = ${firstPolicy === undefined ? '（未指定）' : firstPolicy}`,
    `本次传入：policy = ${givenPolicy === undefined ? '（未指定）' : givenPolicy}`,
    '请再次调用本工具，原样传入上面的 confirmToken，并传入与【首次发起】完全一致的 policy；否则不会重启。',
  ].join('\n')
}

/** AI 重启二次认证 + 策略一致性校验（一次性消费；越界即拒绝并给出下一步）。 */
function verifyAiRestart(cfg, confirmToken, policyArg) {
  if (cfg.aiRestartChallenge === false) return { ok: true }
  const entered = typeof confirmToken === 'string' ? confirmToken : undefined
  const now = Date.now()
  const current = pendingChallenge
  const expired = current !== null && now - current.createdAt > CHALLENGE_TTL_MS
  const tokenValid = current !== null && !expired
    && typeof entered === 'string' && entered !== ''
    && current.token === entered

  if (!tokenValid) {
    const reason = current === null ? 'first' : (expired ? 'expired' : 'token-mismatch')
    const token = issueChallenge(policyArg)
    logEvent('ai-restart-challenge-issued', { reason, ttlMs: CHALLENGE_TTL_MS, policy: policyArg ?? null })
    return { ok: true, needConfirm: true, confirmToken: token, message: challengeGuidance(token, policyArg) }
  }

  // 认证串匹配成功：校验 policy 必须与首次完全一致。
  if (current.policy !== policyArg) {
    logEvent('ai-restart-challenge-mismatch', { reason: 'policy-changed' })
    return {
      ok: true,
      needConfirm: true,
      confirmToken: current.token,
      message: policyMismatchGuidance(current.token, current.policy, policyArg),
    }
  }

  pendingChallenge = null // 一次性消费
  logEvent('ai-restart-challenge-matched', { policy: policyArg ?? null })
  return { ok: true }
}

function currentConfig() {
  if (typeof configSource === 'function') {
    try {
      const value = configSource()
      if (value && typeof value === 'object') return { ...DEFAULTS, ...value }
    } catch { /* fall through */ }
  }
  return null
}

/* ── 会话状态 ─────────────────────────────────────────────────────────── */

/** 所有「未完成」会话：进行中的 turn，或有活动 goal 的根会话。 */
async function collectUnfinished(ctx) {
  const ids = new Set()
  let goals = null
  try { goals = ctx.get('goals') } catch { goals = null }
  for (const agent of ctx.agents.roots()) {
    const id = String(agent.id)
    if (agent.status === 'running') {
      ids.add(id)
      continue
    }
    if (goals && typeof goals.get === 'function') {
      try {
        if (goals.get(agent) !== undefined) ids.add(id)
      } catch { /* per-agent best-effort */ }
    }
  }
  return [...ids]
}

/** 空闲快照：running = 仍在跑的根会话数。 */
function idleSnapshot(ctx) {
  const roots = ctx.agents.roots()
  let running = 0
  for (const agent of roots) {
    if (agent.status === 'running') running += 1
  }
  return { total: roots.length, running, idle: roots.length - running }
}

/** 向所有活跃会话注入一条提示（不激活冷会话）。 */
function notifySessions(ctx, text) {
  let sent = 0
  for (const agent of ctx.agents.roots()) {
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'instructions' },
      }))
      sent += 1
    } catch (error) {
      debugLog(`notify: followup failed for ${String(agent.id)}: ${String(error)}`)
    }
  }
  return sent
}

/* ── 重启执行与策略 ───────────────────────────────────────────────────── */

function publicPending() {
  if (pendingPlan === null) return null
  return {
    policy: pendingPlan.policy,
    source: pendingPlan.source,
    startedAt: pendingPlan.startedAt,
    deadline: pendingPlan.deadline,
    noticeSent: pendingPlan.noticeSent,
    phase: pendingPlan.phase,
  }
}

/** 真正安排重启：写恢复标记 → exit 非零（监管者拉起）或 detach helper。 */
async function finalizeRestart(ctx, source, delayMs, policy) {
  const sessionIds = await collectUnfinished(ctx)
  if (sessionIds.length > 0) writeResumeMarker(sessionIds, source)
  const mode = relaunchMode()
  const info = {
    ok: true,
    accepted: true,
    phase: 'restarting',
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
    mode,
    policy,
    delayMs,
    source,
    sessionIds,
  }
  pendingPlan = { policy, source, startedAt: Date.now(), deadline: Date.now() + delayMs, noticeSent: true, phase: 'restarting' }
  if (suppressFinalize === true) {
    info.relaunch = 'suppressed-test'
    debugLog('finalize suppressed (test)')
  } else if (mode === 'self') {
    const helper = spawnSelfRelaunch(delayMs)
    info.relaunch = 'self'
    info.logOut = helper.logOut
    info.logErr = helper.logErr
    info.helperPid = helper.helperPid
    // 关键：旧进程必须同样在 delayMs 后退出并把端口让出来，
    // helper 在 delayMs+800 后才会用同一 argv 拉起新实例。
    scheduleRestartExit(delayMs)
  } else {
    scheduleRestartExit(delayMs)
    info.relaunch = mode
  }
  lastOutcome = { at: Date.now(), kind: 'restarting', policy }
  debugLog(`restart finalized: policy=${policy} mode=${info.relaunch} delay=${delayMs} sessions=${sessionIds.length}`)
  logEvent('restart-finalized', { source, policy, mode: info.relaunch, delayMs, sessions: sessionIds.length })
  return info
}

/** 等待循环：wait-idle 等全部空闲；notify 先通知再等（可提前）。 */
async function tickWaiting(ctx) {
  if (pendingPlan === null || pendingPlan.phase !== 'waiting') return
  const cfg = currentConfig() || DEFAULTS
  const plan = pendingPlan
  const idleness = idleSnapshot(ctx)

  if (plan.policy === 'notify' && plan.noticeSent !== true) {
    const minutes = Math.max(1, Math.round(cfg.notifyWaitMs / 60000))
    const text = String(cfg.notifyPrompt).replaceAll('{minutes}', String(minutes))
    const sent = notifySessions(ctx, text)
    plan.noticeSent = true
    debugLog(`notify: injected notice to ${sent} session(s), waiting ${cfg.notifyWaitMs}ms`)
  }

  const now = Date.now()
  const allIdle = idleness.running === 0
  const expired = now >= plan.deadline
  // AI 发起的等待：即便会话已全部空闲，也要等到 3 分钟下限（floor）后再真正重启。
  const floorReached = !plan.floor || now >= plan.floor

  if (plan.policy === 'wait-idle') {
    if (allIdle && floorReached) { await finalizeRestart(ctx, plan.source, cfg.restartDelayMs, 'wait-idle'); return }
    if (expired) {
      pendingPlan = null
      lastOutcome = { at: Date.now(), kind: 'cancelled', policy: 'wait-idle', reason: '等待空闲超时，已取消' }
      debugLog('wait-idle: timeout, cancelled')
      logEvent('restart-cancelled', { policy: 'wait-idle', reason: 'timeout' })
    }
    return
  }

  if (allIdle && cfg.notifyRestartWhenIdle && floorReached) { await finalizeRestart(ctx, plan.source, cfg.restartDelayMs, 'notify'); return }
  if (expired) { await finalizeRestart(ctx, plan.source, cfg.restartDelayMs, 'notify'); return }
}

/** 安排一次重启（策略入口）。 */
async function requestRestart(ctx, source, options) {
  const cfg = currentConfig() || DEFAULTS
  if (options.policy !== undefined && !POLICY_VALUES.has(options.policy)) {
    return { ok: false, error: '「policy」必须是 now / wait-idle / notify 之一' }
  }
  const policy = options.policy !== undefined
    ? options.policy
    : (POLICY_VALUES.has(cfg.restartPolicy) ? cfg.restartPolicy : 'now')
  let delayMs = cfg.restartDelayMs
  if (options.delayMs !== undefined) {
    const number = Number(options.delayMs)
    if (!Number.isFinite(number) || number < RANGES.restartDelayMs.min || number > RANGES.restartDelayMs.max) {
      return { ok: false, error: `「delayMs」超出范围 ${RANGES.restartDelayMs.min}~${RANGES.restartDelayMs.max} 毫秒` }
    }
    delayMs = Math.floor(number)
  }

  if (options.dryRun === true) {
    const sessionIds = await collectUnfinished(ctx)
    return {
      ok: true,
      dryRun: true,
      policy,
      delayMs,
      preflight: preflight(),
      wouldResume: sessionIds,
      idleness: idleSnapshot(ctx),
    }
  }
  if (source === 'tool' && policy === 'now') {
    logEvent('ai-restart-denied', { reason: 'now-policy-disabled' })
    return {
      ok: false,
      error: 'AI 发起重启已禁用「立即重启」；请使用 wait-idle 或 notify 策略（倒计时至少 3 分钟，并会向用户弹窗提醒）',
    }
  }
  if (pendingPlan !== null) {
    return { ok: false, error: '已有一次重启在等待中（可先取消）', pending: publicPending() }
  }
  if (policy === 'now') return await finalizeRestart(ctx, source, delayMs, 'now')

  const now = Date.now()
  // AI 发起的等待型重启：无论会话多快空闲，倒计时都不少于 3 分钟（给用户弹窗与取消时间）。
  const floor = source === 'tool' ? now + AI_MIN_COUNTDOWN_MS : 0
  pendingPlan = {
    policy,
    source,
    startedAt: now,
    deadline: Math.max(now + (policy === 'notify' ? cfg.notifyWaitMs : cfg.waitIdleTimeoutMs), floor),
    floor,
    noticeSent: false,
    phase: 'waiting',
  }
  const timer = setInterval(() => { void tickWaiting(ctx) }, 1000)
  ctx.effect(() => () => clearInterval(timer))
  debugLog(`restart waiting: policy=${policy} deadline=${new Date(pendingPlan.deadline).toISOString()}`)
  logEvent('restart-waiting', { source, policy, etaMs: pendingPlan.deadline - Date.now() })
  return {
    ok: true,
    accepted: true,
    phase: 'waiting',
    source,
    policy,
    etaMs: pendingPlan.deadline - Date.now(),
    deadline: pendingPlan.deadline,
    idleness: idleSnapshot(ctx),
  }
}

/** 取消等待中的重启。requireSource=true 时只允许取消 AI（工具）发起的等待。 */
function cancelPending(requireSource) {
  if (pendingPlan === null || pendingPlan.phase !== 'waiting') {
    return { ok: false, error: '当前没有等待中的重启可取消' }
  }
  if (requireSource === true && pendingPlan.source !== 'tool') {
    return { ok: false, error: '该等待中的重启不是 AI 发起的，AI 无法取消（发起方可在设置页取消）' }
  }
  const plan = pendingPlan
  pendingPlan = null
  lastOutcome = {
    at: Date.now(),
    kind: 'cancelled',
    policy: plan.policy,
    reason: requireSource === true ? 'AI 取消' : '用户取消',
  }
  debugLog(`restart cancelled (policy=${plan.policy} by=${requireSource === true ? 'tool' : plan.source})`)
  logEvent('restart-cancelled', { policy: plan.policy, by: requireSource === true ? 'tool' : plan.source })
  return { ok: true, cancelled: true, policy: plan.policy }
}

function statusPayload(ctx) {
  const cfg = currentConfig() || DEFAULTS
  return {
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
    mode: relaunchMode(),
    policy: cfg.restartPolicy,
    aiRestartEnabled: cfg.aiRestartEnabled !== false,
    idleness: idleSnapshot(ctx),
    pending: publicPending(),
    lastOutcome,
  }
}

/* ── 自动继续（新进程启动时消费恢复标记）─────────────────────────────── */

function followupContinue(ctx, sessionId, text) {
  const agent = ctx.agents.get(sessionId)
  if (!agent) return false
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'instructions' },
    }))
    return true
  } catch (error) {
    debugLog(`auto-continue: followup failed for ${sessionId}: ${String(error && error.stack || error)}`)
    return false
  }
}

async function promptResume(ctx, sessionId, text) {
  try {
    const sc = ctx.get('sessionController')
    if (!sc || typeof sc.prompt !== 'function') return
    await sc.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      requestId: `dsh-harness-restart-${sessionId}-${Date.now()}`,
    })
    debugLog(`auto-continue: prompt-resumed ${sessionId}`)
  } catch (error) {
    debugLog(`auto-continue: prompt-resume failed for ${sessionId}: ${String(error && error.message || error)}`)
  }
}

function tryAutoContinue(ctx) {
  let sessionIds = []
  try { sessionIds = readResumeMarker() } catch { sessionIds = [] }
  if (sessionIds.length === 0) return
  debugLog(`auto-continue: marker has ${sessionIds.length} session(s): ${JSON.stringify(sessionIds)}`)
  const pending = new Set(sessionIds)
  const startedAt = Date.now()
  const timer = setInterval(() => {
    const text = (currentConfig() || DEFAULTS).continuePrompt
    for (const id of [...pending]) {
      if (followupContinue(ctx, id, text)) {
        pending.delete(id)
        debugLog(`auto-continue: followup sent to ${id}`)
      }
    }
    if (pending.size === 0) {
      clearInterval(timer)
      clearResumeMarker()
      debugLog('auto-continue: all sessions continued, marker cleared')
    } else if (Date.now() - startedAt > 60000) {
      for (const id of [...pending]) void promptResume(ctx, id, (currentConfig() || DEFAULTS).continuePrompt)
      clearInterval(timer)
      clearResumeMarker()
      debugLog(`auto-continue: fallback prompt-resume for ${[...pending].join(', ')}`)
    }
  }, 500)
  ctx.effect(() => () => clearInterval(timer))
}

/* ── HTTP 守卫与凭证交接 ─────────────────────────────────────────────────
 *
 * dsh 每次启动都会**轮换** launch token，旧页面无法靠自身刷新恢复。核心提供了：
 *   - `connection.requestRejection({ headers })`：给「另一个 Web 路由」套上
 *     Host/Origin 检查与浏览器鉴权（403 = 来源不可信，401 = 凭证失效）。
 *   - `connection.authenticatedUrl(baseUrl)`：把**当前进程的新 token** 加到应用 URL 上。
 * 恢复链路：页面（探针不需要凭证即可读）拿到新 URL → 打开 → 服务端换新 cookie
 * 并 303 回干净 `/`。安全边界见 README「凭证轮换下的自动恢复」。
 */

function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 只允许本机 / 私有网段 IP 字面量 + 同源——域名（含 DNS rebinding）一律拒绝。 */
function isLocalAuthority(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  let host = hostHeader.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end === -1) return false
    host = host.slice(1, end)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  }
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (octets === null) return false
  const a = Number(octets[1])
  const b = Number(octets[2])
  if (a === 127 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

function isSameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function coreRejection(req) {
  if (connectionRef === null || typeof connectionRef.requestRejection !== 'function') return undefined
  try {
    return connectionRef.requestRejection({ headers: req.headers })
  } catch (error) {
    debugLog(`requestRejection failed, falling back to local check: ${String(error)}`)
    return undefined
  }
}

/** 读取类路由：核心 403 一律拒绝；核心 401（凭证轮换）允许本机/私有网段同源降级。 */
function authorizeProbe(req) {
  const rejection = coreRejection(req)
  if (rejection === 403) return 403
  if (!isLocalAuthority(req.headers.host) || !isSameOrigin(req)) return 403
  return undefined
}

/** 变更类路由（重启/取消/改配置）：要求核心完整鉴权；无连接服务时退回本机同源。 */
function authorizeRestart(req) {
  const rejection = coreRejection(req)
  if (rejection !== undefined) return rejection
  if (connectionRef !== null && typeof connectionRef.requestRejection === 'function') return undefined
  return isLoopbackRequest(req) && isSameOrigin(req) ? undefined : 403
}

function currentAccessUrl(req) {
  if (connectionRef === null || typeof connectionRef.authenticatedUrl !== 'function') return null
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return null
  try {
    return connectionRef.authenticatedUrl(`http://${host}`)
  } catch (error) {
    debugLog(`authenticatedUrl failed: ${String(error)}`)
    return null
  }
}

function deny(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
  res.end(status === 403 ? 'forbidden' : 'unauthorized')
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req) {
  try {
    const raw = req.read ? Buffer.from(req.read() || '').toString('utf8') : ''
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** 严格校验配置补丁：全部合法才通过，任一越界/非法即整体报错（绝不静默钳制）。 */
function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object') {
    return { ok: false, error: '配置必须是对象' }
  }
  const entries = Object.entries(patch)
  if (entries.length === 0) return { ok: false, error: '没有可写入的配置项' }
  const errors = []
  const values = {}
  for (const [key, value] of entries) {
    if (!CONFIG_KEYS.has(key)) {
      errors.push(`未知配置项「${key}」`)
      continue
    }
    if (key === 'continuePrompt' || key === 'notifyPrompt') {
      if (typeof value === 'string' && value.trim() !== '' && value.length <= 2000) values[key] = value.trim()
      else errors.push(`「${key}」必须是非空字符串（≤2000 字符）`)
      continue
    }
    if (key === 'aiRestartChallenge' || key === 'aiRestartEnabled' || key === 'notifyRestartWhenIdle') {
      if (typeof value === 'boolean') values[key] = value
      else errors.push(`「${key}」必须是布尔值`)
      continue
    }
    if (key === 'restartPolicy') {
      if (POLICY_VALUES.has(value)) values[key] = value
      else errors.push('「restartPolicy」必须是 now / wait-idle / notify 之一')
      continue
    }
    const range = RANGES[key]
    if (range === undefined) {
      errors.push(`未知配置项「${key}」`)
      continue
    }
    const number = Number(value)
    if (!Number.isFinite(number)) {
      errors.push(`「${key}」必须是数字（毫秒）`)
      continue
    }
    if (number < range.min || number > range.max) {
      errors.push(`「${key}」超出范围 ${range.min}~${range.max} 毫秒`)
      continue
    }
    values[key] = Math.floor(number)
  }
  if (errors.length > 0) return { ok: false, error: `配置无效：${errors.join('；')}` }
  return { ok: true, values }
}

/* ── 路由处理 ─────────────────────────────────────────────────────────── */

function statusRouteHandler(ctx, req, res) {
  const denial = authorizeProbe(req)
  if (denial !== undefined) { deny(res, denial); return }
  json(res, 200, { ...statusPayload(ctx), url: currentAccessUrl(req) })
}

function identityRouteHandler(ctx, req, res) {
  const denial = authorizeProbe(req)
  if (denial !== undefined) { deny(res, denial); return }
  json(res, 200, {
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
    mode: relaunchMode(),
    url: currentAccessUrl(req),
  })
}

function configRouteHandler(ctx, req, res) {
  if (req.method === 'GET') {
    const denial = authorizeProbe(req)
    if (denial !== undefined) { deny(res, denial); return }
    json(res, 200, { ok: true, config: currentConfig() || DEFAULTS })
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' }); res.end('method not allowed'); return
  }
  const denial = authorizeRestart(req)
  if (denial !== undefined) { deny(res, denial); return }
  let settingsService = null
  try { settingsService = ctx.get('settings') } catch { settingsService = null }
  if (settingsService === null || typeof settingsService.update !== 'function') {
    json(res, 503, { ok: false, error: '设置服务不可用，配置未保存' })
    return
  }
  const verdict = validatePatch(readJsonBody(req).patch)
  if (verdict.ok !== true) {
    json(res, 400, { ok: false, error: verdict.error })
    return
  }
  const merged = { ...(currentConfig() || DEFAULTS), ...verdict.values }
  void settingsService.update('dsh-harness-restart', verdict.values)
    .then(() => json(res, 200, { ok: true, config: merged }))
    .catch((error) => json(res, 500, { ok: false, error: String(error && error.message || error) }))
}

function restartRouteHandler(ctx, req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }); res.end('method not allowed'); return
  }
  const denial = authorizeRestart(req)
  if (denial !== undefined) { deny(res, denial); return }
  const body = readJsonBody(req)
  void requestRestart(ctx, 'button', {
    policy: typeof body.policy === 'string' ? body.policy : undefined,
    delayMs: body.delayMs,
    dryRun: body.dryRun === true,
  })
    .then((result) => json(res, result.ok === true ? 202 : 409, result))
    .catch((error) => json(res, 500, { ok: false, error: String(error && error.message || error) }))
}

function cancelRouteHandler(ctx, req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }); res.end('method not allowed'); return
  }
  const denial = authorizeRestart(req)
  if (denial !== undefined) { deny(res, denial); return }
  const result = cancelPending(false)
  json(res, result.ok === true ? 200 : 409, result)
}

function checkRouteHandler(ctx, req, res) {
  const denial = authorizeProbe(req)
  if (denial !== undefined) { deny(res, denial); return }
  json(res, 200, preflight())
}

/** 日志尾部（设置页「日志」卡片用）。 */
function logRouteHandler(ctx, req, res) {
  const denial = authorizeProbe(req)
  if (denial !== undefined) { deny(res, denial); return }
  let lines = 200
  try {
    const url = new URL(req.url || '/', 'http://dsh.invalid')
    const requested = Number(url.searchParams.get('lines'))
    if (Number.isFinite(requested) && requested > 0) lines = Math.min(2000, Math.floor(requested))
  } catch { /* default */ }
  const tail = readLogTail(lines)
  json(res, 200, { ok: tail.ok !== false, path: tail.path || debugLogPath(), lines: tail.lines || [], error: tail.error })
}

/** 一键在桌面文件管理器里打开日志源文件（尽力而为，失败返回路径供手动打开）。 */
async function logOpenRouteHandler(ctx, req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }); res.end('method not allowed'); return
  }
  const denial = authorizeRestart(req)
  if (denial !== undefined) { deny(res, denial); return }
  const path = debugLogPath()
  const result = { ok: false, opened: false, path }
  try {
    const sc = ctx.get('sessionController')
    if (sc && typeof sc.workspaceDesktop === 'function') {
      const desktop = sc.workspaceDesktop()
      result.desktop = desktop && desktop.name ? desktop.name : undefined
      result.available = desktop ? desktop.available === true : false
    }
    if (sc && typeof sc.openWorkspacePath === 'function') {
      await sc.openWorkspacePath({ path, action: 'reveal' })
      result.ok = true
      result.opened = true
      logEvent('log-opened', { path })
    } else {
      result.error = '当前部署不提供原生打开能力，请手动打开该路径'
    }
  } catch (error) {
    result.error = String(error && error.message || error)
    debugLog(`log open failed: ${result.error}`)
  }
  json(res, result.opened === true ? 200 : 501, result)
}

/* ── 插件主体 ─────────────────────────────────────────────────────────── */

export function apply(ctx, config) {
  const bootConfig = resolveConfig(config)
  debugLog(`apply pid=${process.pid} mode=${relaunchMode()} policy=${bootConfig.restartPolicy} marker=${readResumeMarker().length}`)

  try {
    const settingsService = ctx.get('settings')
    if (settingsService && typeof settingsService.installSection === 'function') {
      settingsService.installSection(ctx, 'dsh-harness-restart', Config, bootConfig, {
        setSource: (get) => { configSource = get },
        onChange: () => {},
      })
    }
  } catch (error) {
    debugLog(`settings installSection skipped: ${String(error)}`)
  }
  configSource = configSource || (() => bootConfig)

  ctx.inject(['connection'], (connectionCtx) => {
    connectionRef = connectionCtx.connection
    debugLog('connection captured: url handoff + restart auth available')
  })

  tryAutoContinue(ctx)

  const routes = [
    ['/status', (req, res) => statusRouteHandler(ctx, req, res)],
    ['/restart', (req, res) => (req.method === 'GET' ? identityRouteHandler(ctx, req, res) : restartRouteHandler(ctx, req, res))],
    ['/config', (req, res) => configRouteHandler(ctx, req, res)],
    ['/cancel', (req, res) => cancelRouteHandler(ctx, req, res)],
    ['/check', (req, res) => checkRouteHandler(ctx, req, res)],
    ['/log', (req, res) => logRouteHandler(ctx, req, res)],
    ['/log/open', (req, res) => { void logOpenRouteHandler(ctx, req, res) }],
  ]
  for (const [suffix, handler] of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `/plugins/dsh-harness-restart${suffix}`,
      handler,
    }), `dsh-harness-restart: ${suffix} route`)
  }

  ctx.tools.register(defineTool({
    name: 'dsh_restart',
    description:
      '重启整个 DeepSeek Harness 进程（重载 profile 插件与设置）；重启后未完成的工作会自动继续。'
      + '每次调用都必须严格遵循本次返回值里的指示再决定下一步。',
    parameters: {
      confirmToken: { type: 'string', description: '（可选）认证串：上轮调用返回的 16 位随机串；首次调用不填。' },
      policy: { type: 'string', description: '重启策略，仅允许：wait-idle / notify（AI 禁用 now=立即重启；省略则用设置默认，若默认为 now 会被拒绝）。' },
      delayMs: { type: 'number', description: '旧进程退出前等待毫秒数，范围 0–60000，默认取配置。' },
      dryRun: { type: 'boolean', description: '只预检并列出将恢复的会话与当前策略，不重启。' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const a = args || {}
      const cfg = currentConfig() || bootConfig
      if (a.dryRun === true) {
        const result = await requestRestart(ctx, 'tool', { policy: a.policy, delayMs: a.delayMs, dryRun: true })
        logEvent('ai-restart-dryrun', { policy: a.policy })
        return result
      }
      if (cfg.aiRestartEnabled === false) {
        logEvent('ai-restart-denied', { reason: 'disabled' })
        return { ok: false, error: 'AI 重启已被禁用（设置 → DSH 重启 → 允许 AI 使用重启）' }
      }
      if (a.policy === 'now') {
        logEvent('ai-restart-denied', { reason: 'now-policy-disabled' })
        return { ok: false, error: 'AI 发起重启已禁用「立即重启」；请使用 wait-idle 或 notify 策略（倒计时至少 3 分钟，并会向用户弹窗提醒）' }
      }
      // 二次认证 + 策略一致性：首次调用只发挑战与引导；
      // 二次调用必须携带同一 confirmToken 且 policy 与首次完全一致才真正重启。
      const verdict = verifyAiRestart(cfg, a.confirmToken, a.policy)
      if (verdict.needConfirm === true) {
        return {
          ok: true,
          restarted: false,
          needConfirm: true,
          confirmToken: verdict.confirmToken,
          message: verdict.message,
        }
      }
      const result = await requestRestart(ctx, 'tool', { policy: a.policy, delayMs: a.delayMs })
      logEvent('ai-restart-requested', { policy: a.policy, phase: result.phase })
      return result
    },
  }))

  // AI 取消工具：仅对 AI（工具）发起的「等待中」重启生效。
  ctx.tools.register(defineTool({
    name: 'dsh_restart_cancel',
    description:
      '取消一个「等待中」的、由 AI（dsh_restart 工具）发起的重启。'
      + '仅对 AI 发起的重启生效：如果当前等待中的重启是设置页按钮或 /restart 命令发起的，'
      + '或根本没有等待中的重启，返回错误。不会取消已经开始退出的重启。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute() {
      const result = cancelPending(true)
      if (result.ok !== true) logEvent('ai-restart-cancel-denied', { reason: (result.error || 'none') })
      return result
    },
  }))

  try {
    const commandsService = ctx.get('commands')
    if (commandsService && typeof commandsService.register === 'function') {
      ctx.effect(() => commandsService.register({
        name: 'restart',
        description: '重启 DeepSeek Harness（按设置里的策略；未完成会话重启后自动继续）',
        recordInput: false,
        async handler() {
          const result = await requestRestart(ctx, 'command', {})
          if (result.ok !== true) return { kind: 'error', text: result.error || '重启失败' }
          if (result.phase === 'waiting') {
            return {
              kind: 'success',
              text: `已进入等待：策略 ${result.policy}，最长等待 ${Math.round((result.etaMs || 0) / 60000)} 分钟（可在设置页取消）。`,
            }
          }
          return {
            kind: 'success',
            text: `已安排重启（${result.relaunch} 模式，${result.delayMs}ms 后），将自动继续 ${result.sessionIds.length} 个未完成会话。`,
          }
        },
      }), 'dsh-harness-restart: restart command')
    }
  } catch (error) {
    debugLog(`commands.register skipped: ${String(error)}`)
  }

  debugLog('apply complete')
}

/* ── 纯函数导出（仅用于离线单测，不参与运行时）───────────────────────── */
export const __test = {
  isLocalAuthority,
  isSameOrigin,
  authorizeProbe,
  authorizeRestart,
  validatePatch,
  cancelPending,
  issueChallenge,
  consumeChallenge,
  challengeState,
  verifyAiRestart,
  challengeGuidance,
  policyMismatchGuidance,
  requestRestart,
  tickWaiting,
  idleSnapshot,
  suppressFinalize: (value) => { suppressFinalize = value },
  setPendingPlan: (value) => { pendingPlan = value },
  setChallenge: (value) => { pendingChallenge = value },
  setConnection: (value) => { connectionRef = value },
}
