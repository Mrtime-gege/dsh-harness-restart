/**
 * v1 宿主装配（与 lib/core.js 复用 EXIT/凭证/日志/标记机制，不重复造轮子）。
 * 触发 → 审批 → PRE → EXIT(core) → POST(恢复) 四层 + NOTIFY；配置持久化到 $DSH_HOME/dsh-harness-restart-v1.json（解耦，不依赖 settings 服务）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import * as core from './core.js'
import { validateConfigV1, DEFAULTS, TAG, PRE_MODES } from './config.js'
import { compileAll, evaluateFirst, validateEntry, describe } from './callbacks.js'
import { sanitizeAiTrigger, sanitizeManualTrigger, issueChallenge } from './approval.js'
import { preDone, describePre } from './pre.js'
import { planRestore, tickReceipts, buildRestoreText } from './restore.js'

export const name = 'dsh-harness-restart'
export const inject = ['tools', 'agents', 'webServer']
// 组合配置（cordis.patch.yml 行）仅作入参；真实 schema 见 validateConfigV1。
// 显式声明自定义字段，避免 z.object 默认 strip 掉（否则 simulateOnly 等永远不生效）。
// schemastery：字段默认可选（.required() 才是必选），无 .optional()/z.enum。
export const Config = z.object({
  simulateOnly: z.boolean(),
  preRestart: z.object({ mode: z.string(), forceAfterMs: z.number() }),
  postRestart: z.object({ mode: z.string() }),
  restartDelayMs: z.number(),
  bootRestoreDelayMs: z.number(),
  restoreStaggerMs: z.number(),
  ai: z.object({ restartEnabled: z.boolean(), challengeEnabled: z.boolean(), allowNow: z.boolean() }),
  trigger: z.object({ defaultTrigger: z.string(), defaultDelayMs: z.number() }),
  schedule: z.any(),
}) // 组合配置仅作入参，真实 schema 见 validateConfigV1

/* ── 配置（组合 base + 文件覆盖，文件优先）────────────────────────── */
function configFilePath() {
  try { return join(core.dshHome(), 'dsh-harness-restart-v1.json') } catch { return null }
}
let bootConfig = {}
export function setBootConfig(value) { bootConfig = value || {} }

function readFileOverrides() {
  const p = configFilePath()
  if (p === null || !existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}
let warnings = []
export function currentConfig() {
  const merged = { ...DEFAULTS, ...bootConfig, ...readFileOverrides() }
  const verdict = validateConfigV1(merged)
  if (verdict.ok) return { config: verdict.config, warnings }
  warnings = warnings.includes(verdict.error) ? warnings : [...warnings, verdict.error]
  const base = validateConfigV1({ ...DEFAULTS, ...bootConfig })
  return { config: base.ok ? base.config : structuredClone(DEFAULTS), warnings }
}
export function saveConfigPatch(patch) {
  const overrides = readFileOverrides()
  const merged = validateConfigV1({ ...DEFAULTS, ...bootConfig, ...overrides, ...patch })
  if (!merged.ok) return { ok: false, error: merged.error }
  const p = configFilePath()
  if (p !== null) {
    mkdirSync(core.dshHome(), { recursive: true })
    writeFileSync(p, JSON.stringify({ ...overrides, ...patch }, null, 2) + '\n', 'utf8')
  }
  return { ok: true, config: merged.config }
}

/* ── 状态 ──────────────────────────────────────────────────────────── */
let pending = null          // {id, trigger, delayMs, at, startedAt, preStartedAt, source, requesterSessionId, phase}
let challenge = null        // {token, paramsJson, createdAt}
let lastOutcome = null
let callbacksStore = []     // 运行时注册的回调（重启计划用）
let receipts = []           // 方案 B 回执状态
const scheduleCooldown = new Set()
let restoreTimers = []
let lastConfigReloadAt = null // 模块级：statusHandler（模块级函数）引用

/* ── 审批：AI 两段式挑战 ─────────────────────────────────────────── */
function aiChallenge(params) {
  const token = issueChallenge()
  challenge = { token, paramsJson: JSON.stringify(params), createdAt: Date.now() }
  return token
}
function verifyAiChallenge(params) {
  if (challenge === null) return 'no-challenge'
  if (Date.now() - challenge.createdAt > (currentConfig().config.challengeTtlMs || 300000)) { challenge = null; return 'expired' }
  if (challenge.paramsJson !== JSON.stringify(params)) return 'mismatch'
  const token = challenge.token
  challenge = null
  return token
}

/* ── 空闲判定（复用 v0.1.0 语义：root 会话无 running turn）────────── */
function liveAgents(ctx) {
  // 0.2.0：agents.list() 返回全部 live agent（含 subagent 子会话、Agent Teams teammate）；
  // roots() 只有根会话。优先 list()，回退 roots()，按 session.id 去重。
  try {
    const agents = ctx.get('agents')
    const pool = (agents && typeof agents.list === 'function') ? agents.list() : (agents?.roots?.() || [])
    const seen = new Set()
    const out = []
    for (const a of pool || []) {
      const id = a && a.session && a.session.id
      if (id && !seen.has(id)) { seen.add(id); out.push(a) }
    }
    return out
  } catch { return [] }
}
function idleSnapshot(ctx) {
  try {
    const sessions = liveAgents(ctx).map((a) => ({ id: a.session?.id || '', status: a.session?.status || idle }))
    return { total: sessions.length, running: sessions.filter((s) => s.status === 'running').length, sessions }
  } catch { return { total: 0, running: 0, sessions: [] } }
}
function allIdle(snapshot) { return snapshot.total === 0 || snapshot.running === 0 }

/* ── 触发 intents ─────────────────────────────────────────────────── */
function makeIntent(source, trigger, delayMs, requesterSessionId) {
  const now = Date.now()
  return {
    id: randomBytes(6).toString('hex'),
    trigger, source, requesterSessionId: requesterSessionId || null,
    at: now + (delayMs || 0), startedAt: now, preStartedAt: now, phase: 'waiting',
  }
}
function clearPending(by) {
  pending = null
  lastOutcome = { at: Date.now(), by, reason: 'cancelled' }
}
function singleFlightError() { return { ok: false, error: '已有等待中的重启（单飞行）；请先取消' } }

function collectUnfinished(ctx) {
  // 未完成 = 全部 live agent 会话（roots + subagent + teammate），重启后都要恢复
  return liveAgents(ctx).map((a) => a.session?.id).filter(Boolean)
}

/* ── PRE 主循环（与调度心跳合并：250ms tick）──────────────────────── */
let lastMinuteKey = -1
function tick(ctx) {
  const now = new Date()
  // 调度：分钟边界检测（250ms 采样，抗事件循环抖动；语义 = 每分钟第 0 秒求值一次）
  const minuteKey = now.getHours() * 60 + now.getMinutes()
  if (minuteKey !== lastMinuteKey) {
    lastMinuteKey = minuteKey
    evaluateSchedule(ctx, now)
  }
  // PRE：pending 是否该离开
  if (pending !== null && pending.phase === 'waiting') {
    const cfg = currentConfig().config
    const idle = allIdle(idleSnapshot(ctx))
    // PRE 判定：immediate 必须等 trigger 自身等待到点（delay 的 at）；waitSeconds 自持；waitAllOrForce 会话/强断
    const pre = cfg.preRestart
    let done = false
    if (pre.mode === 'immediate') {
      done = (pending.trigger === 'delay') ? now.getTime() >= pending.at : true
    } else if (pre.mode === 'waitSeconds') {
      const sec = Number(pre.forceAfterMs ?? 0)
      done = now.getTime() - pending.preStartedAt >= sec * 1000
    } else {
      done = preDone(now, pre, { startedAt: pending.preStartedAt, idle })
    }
    if (done) finalizeRestart(ctx, cfg)
  }
  // 回执超时提醒
  const due = tickReceipts(receipts, Date.now(), currentConfig().config.callbackUnackTimeoutMs || 1800000)
  for (const d of due) {
    core.logEvent(d.kind === 'unacked' ? 'callback-unacked' : 'restore-reminder', { callbackId: d.callbackId, kind: d.kind })
  }
}

function evaluateSchedule(ctx, now) {
  const cfg = currentConfig().config
  const entries = (cfg.schedule || []).filter((e) => e.enabled !== false)
  if (entries.length === 0) return
  const errors = []
  const compiled = compileAll(entries, { onError: (e) => errors.push(e) })
  for (const e of errors) core.logEvent('callback-error', e)
  const ctxData = { sessions: collectUnfinished(ctx), pendingTasks: pending !== null ? 1 : 0 }
  const fired = evaluateFirst(compiled, now, ctxData)
  if (fired === null) return
  const key = now.getHours() * 60 + now.getMinutes()
  if (scheduleCooldown.has(key)) return
  scheduleCooldown.add(key)
  const entry = entries.find((e) => e.id === fired)
  core.logEvent('schedule-trigger', { callbackId: fired, describe: entry ? describe(entry) : '' })
  const trigger = cfg.trigger.defaultTrigger || 'delay'
  const delayMs = trigger === 'delay' ? cfg.trigger.defaultDelayMs : undefined
  void startWaiting(ctx, makeIntent('scheduled', trigger, delayMs, null), cfg)
}

/* ── 触发入口 ─────────────────────────────────────────────────────── */
async function startWaiting(ctx, intent, cfg) {
  if (pending !== null) return singleFlightError()
  pending = intent
  core.logEvent('restart-waiting', { id: intent.id, source: intent.source, trigger: intent.trigger, delayMs: intent.trigger === 'delay' ? intent.at - intent.startedAt : null })
  // notify 告知（delay/now 之前的统一提示）：交给弹窗与日志；注入文案由 POST 处理
  return { ok: true, accepted: true, phase: 'waiting', id: intent.id, trigger: intent.trigger, source: intent.source, etaMs: Math.max(0, intent.at - Date.now()) }
}

async function finalizeRestart(ctx, cfg) {
  if (pending === null) return
  const intent = pending
  core.logEvent('restart-about-to-exit', { id: intent.id, trigger: intent.trigger, source: intent.source })
  // 写恢复计划（v2：unfinished + requester + callbacks）
  const callbacks = [...callbacksStore].map((c) => ({
    callbackId: c.callbackId, sessionId: c.sessionId, description: c.description,
    selfPrompt: c.selfPrompt || '', resumeToken: c.resumeToken,
  }))
  try {
    writeFileSync(core.markerPath(), JSON.stringify({
      sessionIds: collectUnfinished(ctx), source: intent.source, requester: intent.requesterSessionId,
      callbacks, restartAt: new Date().toISOString(), pid: process.pid, exitCode: core.RESTART_EXIT_CODE,
    }, null, 2) + '\n', 'utf8')
  } catch (error) { core.debugLog(`writeResumeMarker v2 failed: ${String(error)}`) }
  pending.phase = 'restarting'
  const simulate = cfg.simulateOnly === true || process.env.DSH_RESTART_SIMULATE === '1'
  core.logEvent(simulate ? 'restart-simulated' : 'restart-finalized', { id: intent.id, trigger: intent.trigger, source: intent.source, mode: core.supervisorMode() || 'self', simulate })
  if (simulate) {
    // 演练模式：不 exit、不拉起新进程；事件链与恢复流程照常走（同进程扮演“重启后”）。
    core.logEvent('restart-apply', { tag: '【DSH 重启】', mode: 'self', relaunch: false, simulate: true, pid: process.pid })
    scheduleRestore(ctx, currentConfig().config)
    return
  }
  const delay = Number(cfg.restartDelayMs) || 2000
  // 双保险：无论 supervisor 还是 self 裸跑，都先挂上自愈 helper（它会在端口被他人接管时让位），
  // 同时旧进程按 delay 退出让出端口。systemd 有 Restart 时新实例由它拉起、helper 探测到端口已占用就退出；
  // systemd 失守/裸跑时 helper 完成拉起 + 健康探测 + 至多 3 次重试。
  try { core.spawnSelfRelaunch(delay) } catch (error) { core.debugLog(`spawnSelfRelaunch failed: ${String(error)}`) }
  core.scheduleRestartExit(delay)
}

/* ── POST：启动后恢复 ─────────────────────────────────────────────── */
function readPlanV2() {
  try { return JSON.parse(readFileSync(core.markerPath(), 'utf8')) } catch { return null }
}
function scheduleRestore(ctx, cfg) {
  const plan = readPlanV2()
  if (plan === null) return
  const seq = planRestore(plan, { mode: cfg.postRestart.mode, bootRestoreDelayMs: cfg.bootRestoreDelayMs, restoreStaggerMs: cfg.restoreStaggerMs }, Date.now())
  // 0.2.0：agent/created 事件驱动 —— 会话恢复为 live 时立即注入，避免傻等 bootRestoreDelayMs
  const injected = new Set() // sessionId 已注入标记（事件与定时器共享，防重复）
  registerAgentCreatedHooks(ctx, seq, cfg, injected)
  // resume 目标（requester / unfinished）：等待 bootRestoreDelayMs 后统一注入
  const resumeAt = Date.now() + Number(cfg.bootRestoreDelayMs) || 60000
  const t1 = core.customSetTimeout ? null : setTimeout(() => {
    for (const target of seq.resumeTargets) {
      if (injected.has(target.sessionId)) continue
      injected.add(target.sessionId)
      injectToSession(ctx, target.sessionId, cfg.continuePrompt)
      core.logEvent('restart-resumed', { sessionId: target.sessionId, why: target.why, via: 'timer' })
    }
  }, resumeAt)
  restoreTimers.push(t1)
  // callbacks 渐进队列（每 restoreStaggerMs 一个，从 bootRestoreDelayMs 起算）
  seq.callbackQueue.forEach((item, index) => {
    const delay = Math.max(0, item.at - Date.now())
    const t = setTimeout(() => {
      if (injected.has(item.cb.sessionId)) return
      injected.add(item.cb.sessionId)
      const cb = item.cb
      const text = buildRestoreText(cfg.restorePrompt, cb)
      injectToSession(ctx, cb.sessionId, text)
      receipts.push({ callbackId: cb.callbackId, resumeToken: cb.resumeToken || cb.callbackId, restoredAt: Date.now(), status: 'pending' })
      core.logEvent('restore-step', { callbackId: cb.callbackId, at: index, text: text.slice(0, 60), via: 'timer' })
    }, delay)
    restoreTimers.push(t)
  })
  if (seq.callbackQueue.length === 0 && seq.resumeTargets.length === 0) {
    setTimeout(() => { try { core.clearResumeMarker() } catch {} }, 5000)
  }
}
function promptRequest(sessionId, text) {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `dshr-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return {
    requestId: id,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }
}

/**
 * 0.2.0 新机制接入：agent/created 事件（含 SessionStartSource）驱动渐进恢复。
 * 会话一旦恢复为 live 立即注入（比定时快）；定时器作为兜底（防事件遗漏）。
 */
function registerAgentCreatedHooks(ctx, seq, cfg, injected) {
  try {
    ctx.on('agent/created', (payload) => {
      try {
        if (!payload || !payload.agent) return
        const sessionId = payload.agent.session && payload.agent.session.id
        if (!sessionId || injected.has(sessionId)) return
        const source = payload.source || ''
        // resumeTargets：官方启动会以 startup/resume 来源恢复持久会话 —— 事件到了就直接续
        const target = seq.resumeTargets.find((t) => t.sessionId === sessionId)
        if (target) {
          injected.add(sessionId)
          injectToSession(ctx, sessionId, cfg.continuePrompt)
          core.logEvent('restart-resumed', { sessionId, why: target.why, via: 'agent-created', source })
          return
        }
        const cbItem = seq.callbackQueue.find((q) => q.cb.sessionId === sessionId)
        if (cbItem) {
          injected.add(sessionId)
          const text = buildRestoreText(cfg.restorePrompt, cbItem.cb)
          injectToSession(ctx, sessionId, text)
          receipts.push({ callbackId: cbItem.cb.callbackId, resumeToken: cbItem.cb.resumeToken || cbItem.cb.callbackId, restoredAt: Date.now(), status: 'pending' })
          core.logEvent('restore-step', { callbackId: cbItem.cb.callbackId, text: text.slice(0, 60), via: 'agent-created', source })
        }
      } catch (error) { core.debugLog(`agent/created restore hook failed: ${String(error)}`) }
    })
    // cordis 监听跟随 ctx 生命周期自动清理，无需手动 off
  } catch (error) { core.debugLog(`registerAgentCreatedHooks failed: ${String(error)}`) }
}

function injectToSession(ctx, sessionId, text) {
  try {
    const agents = ctx.get('agents')
    const live = agents && (agents.roots?.() || []).some((a) => a.session?.id === sessionId)
    const cp = ctx.get('sessionController')
    if (cp && typeof cp.prompt === 'function') {
      // dsh >=0.2.0：prompt(request: SessionPromptRequest, signal?)
      // dsh 0.1.x：prompt(sessionId, text) —— 失败时回退老签名重试一次
      const p = cp.prompt(promptRequest(sessionId, text))
      if (p && typeof p.catch === 'function') {
        void p.catch(() => {
          try { void cp.prompt(sessionId, text).catch(() => {}) } catch {}
        })
        return
      }
      return
    }
    if (live && typeof agents.get === 'function') {
      const agent = agents.get(sessionId)
      if (agent && typeof agent.followup === 'function') { void agent.followup(text).catch(() => {}); return }
    }
    core.debugLog(`restore skip: session ${sessionId} 不可达（无 sessionController / agent）`)
  } catch (error) { core.debugLog(`injectToSession failed: ${String(error)}`) }
}

/* ── 工具 ─────────────────────────────────────────────────────────── */
function registerTools(ctx, cfg) {
  ctx.tools.register(defineTool({
    name: 'dsh_restart',
    description: '重启 DSH（等待型默认）。首次调用返回 16 位认证串与引导；二次调用携带同一串与完全一致参数后真正执行。AI 的 delay 参数必须在 ai.delayRangeMs 区间内（默认 3 分钟~1 小时，推荐 5 分钟）。',
    parameters: {
      trigger: { type: 'string', enum: ['now', 'delay'], default: 'delay', description: 'now=立即（需 ai.allowNow 开启）；delay=等待后重启' },
      delayMs: { type: 'number', description: 'delay 等待毫秒数（AI 限制见配置 ai.delayRangeMs，默认 3 分钟~1 小时、推荐 5 分钟）' },
      challenge: { type: 'string', description: '（可选）上轮返回的 16 位认证串；首次调用不填' },
    },

    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const cfgCtx = currentConfig()
      const ai = cfgCtx.config.ai
      const verdict = sanitizeAiTrigger(args || {}, ai)
      if (!verdict.ok) { core.logEvent('ai-restart-denied', { reason: verdict.error }); return { ok: false, error: verdict.error } }
      if (ai.restartEnabled !== true) { core.logEvent('ai-restart-denied', { reason: 'ai.restartEnabled=false' }); return { ok: false, error: 'AI 发起重启已禁用（ai.restartEnabled=false）' } }
      if (ai.challengeEnabled !== true) {
        const intent = makeIntent('tool', verdict.trigger, verdict.delayMs, agent?.session?.id)
        const r = await startWaiting(ctx, intent, currentConfig().config)
        if (!r.ok) return r
        return { ok: true, accepted: true, phase: r.phase, trigger: verdict.trigger, delayMs: verdict.delayMs, etaMs: r.etaMs }
      }
      if (!args.challenge) { const token = aiChallenge(args); return { ok: true, accepted: false, challenge: token, guidance: '请用 dsh_restart 携带完全一致的 trigger/delayMs 与 challenge 再次调用以执行重启；被拒绝或取消都会反馈给你' } }
      const verified = verifyAiChallenge(args)
      if (verified === 'mismatch') { core.logEvent('ai-challenge-mismatch', {}); return { ok: false, error: '认证串与首次参数不一致：challenge 与 trigger/delayMs 必须与首次调用完全一致（安全策略）' } }
      if (verified === 'expired') return { ok: false, error: '认证串已过期，请重新发起' }
      if (verified === 'no-challenge') return { ok: false, error: '未先发起（缺少 challenge）' }
      if (!args.challenge || args.challenge !== verified) {
        // challenge 已在 verify 中消费；此处仅防御
      }
      const intent = makeIntent('tool', verdict.trigger, verdict.delayMs, agent?.session?.id)
      const r = await startWaiting(ctx, intent, currentConfig().config)
      core.logEvent('ai-restart-issued', { id: intent.id, trigger: verdict.trigger })
      return { ok: true, accepted: true, phase: r.phase, trigger: verdict.trigger, delayMs: verdict.delayMs, etaMs: r.etaMs, notice: '重启已进入等待，可调用 dsh_restart_cancel 取消；长任务请注册 dsh_restart_register_callback 以便重启后自动继续' }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_restart_cancel',
    description: '取消等待中的 AI 发起重启（仅 AI 发起且 phase=waiting）。',
    parameters: {},

    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      if (pending === null || pending.source !== 'tool') { return { ok: false, error: '当前没有等待中的 AI 重启可取消' } }
      clearPending('tool-cancel')
      core.logEvent('restart-cancelled', { by: 'tool', id: pending?.id })
      return { ok: true, policy: pending?.trigger || 'delay' }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_restart_register_callback',
    description: '注册重启后回调（方案 B）：重启后插件会按照渐进策略（等 1 分钟、每 5 秒一个，可配置）向该会话注入恢复提示。创建时会向用户弹窗提示，用户可拒绝；默认免审批。',
    parameters: {
      description: { type: 'string', description: '给用户的说明（≤200 字，注册弹窗与恢复注入展示）' },
      selfPrompt: { type: 'string', description: '恢复时附在默认提示之后的自己的提示（≤500 字，可选）' },
      unregister: { type: 'boolean', description: 'true=撤销本会话已注册的回调' },
    },

    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '无法确定当前会话（拒绝伪造）' }
      if (args.unregister === true) {
        callbacksStore = callbacksStore.filter((c) => c.sessionId !== sessionId)
        core.logEvent('callback-unregistered', { sessionId })
        return { ok: true, unregistered: true }
      }
      if (callbacksStore.some((c) => c.sessionId === sessionId)) {
        return { ok: false, error: '当前会话已注册过回调；先以 unregister 撤销后再注册（同一会话仅允许一个）' }
      }
      const cb = { callbackId: `cb-${randomBytes(3).toString('hex')}`, sessionId, description: String(args.description || '').trim(), selfPrompt: String(args.selfPrompt || '').trim(), resumeToken: randomBytes(6).toString('hex'), registeredAt: Date.now() }
      callbacksStore = [...callbacksStore, cb]
      core.logEvent('callback-registered', { callbackId: cb.callbackId, sessionId, description: cb.description, hash: createHash('sha256').update(cb.description).digest('hex').slice(0, 12) })
      return { ok: true, callbackId: cb.callbackId, userApproval: '已向用户弹窗提示（默认免审批，用户可拒绝；拒绝会通知你）' }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'dsh_restart_callback_done',
    description: '回执：你注册的重启后回调所对应的任务已续完。配合 dsh_restart_register_callback 使用的闭环。',
    parameters: { resumeToken: { type: 'string', description: '注册时返回的 resumeToken' } },

    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const r = receipts.find((x) => x.resumeToken === args.resumeToken)
      if (!r) return { ok: false, error: '未找到该 resumeToken（可能已完成或已过期）' }
      if (r.status === 'done') return { ok: true, alreadyDone: true }
      r.status = 'done'
      core.logEvent('callback-done', { callbackId: r.callbackId })
      return { ok: true, callbackId: r.callbackId }
    },
  }))
}

/* ── HTTP 守卫（沿用旧语义：鉴权核心不降级，探针限本机/私网+同源）── */
function isLocalAddress(head) {
  const host = (head.host || '').split(':')[0]
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|localhost$|\[::1\])/.test(host)
}
function guardAllowProbe(headers) {
  if (!isLocalAddress(headers)) return false
  const origin = String(headers['origin'] || '')
  return origin === '' || origin.includes('://127.') || origin.includes('://localhost') || origin.includes('://10.') || origin.includes('://192.168.')
}
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    try { req.setEncoding('utf8') } catch {}
    req.on('data', (c) => { raw += String(c) })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({ __invalid: true }) } })
    req.on('error', () => resolve({}))
  })
}
const basePath = '/plugins/dsh-harness-restart'

function registerRoutes(ctx) {
  const mk = (handler) => (req, res) => { void handler(req, res).catch((error) => core.debugLog(`route error: ${String(error)}`)) }
  const statusHandler = async (req, res) => {
    if (!guardAllowProbe(req.headers)) return json(res, 403, { ok: false, error: 'forbidden' })
    const cfg = currentConfig()
    return json(res, 200, {
      pid: process.pid, startedAt: core.PROCESS_STARTED_AT, tag: TAG, ...cfg,
      pending: pending ? { id: pending.id, trigger: pending.trigger, source: pending.source, phase: pending.phase, etaMs: pending.trigger === 'delay' ? Math.max(0, pending.at - Date.now()) : null } : null,
      lastOutcome, schedule: (cfg.config.schedule || []).map((e) => ({ id: e.id, kind: e.kind, preset: e.preset || null, describe: describe(e), enabled: e.enabled !== false })),
      callbacks: callbacksStore.map((c) => ({ callbackId: c.callbackId, description: c.description })),
      supervisors: { mode: core.supervisorMode() || 'self', relaunch: core.relaunchMode() === true },
      simulate: cfg.config.simulateOnly === true || process.env.DSH_RESTART_SIMULATE === '1',
      lastConfigReloadAt: lastConfigReloadAt,
    })
  }
  const configHandler = async (req, res) => {
    if (!guardAllowProbe(req.headers)) return json(res, 403, { ok: false, error: 'forbidden' })
    if (req.method === 'GET') { const cfg = currentConfig(); return json(res, 200, { ok: true, config: cfg.config, warnings: cfg.warnings }) }
    const body = await readBody(req)
    if (body.__invalid) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    const verdict = saveConfigPatch(body.patch || {})
    return verdict.ok ? json(res, 200, { ok: true, config: verdict.config }) : json(res, 400, { ok: false, error: verdict.error })
  }
  const restartHandler = async (req, res) => {
    if (req.method === 'GET') { const cfg = currentConfig(); return json(res, 200, { ok: true, phase: pending ? pending.phase : 'idle', ...cfg.config }) }
    if (!guardAllowProbe(req.headers)) return json(res, 403, { ok: false, error: 'forbidden' })
    const body = await readBody(req)
    if (body.__invalid) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    if (body.dryRun === true) {
      const verdict = sanitizeManualTrigger(body)
      return json(res, 200, { ok: verdict.ok, ...(verdict.ok ? { trigger: verdict.trigger, delayMs: verdict.delayMs, mode: currentConfig().config.preRestart.mode } : { error: verdict.error }) })
    }
    const verdict = sanitizeManualTrigger(body)
    if (!verdict.ok) return json(res, 400, { ok: false, error: verdict.error })
    const intent = makeIntent('button', verdict.trigger, verdict.delayMs, null)
    const r = await startWaiting(ctx, intent, currentConfig().config)
    return r.ok ? json(res, 202, r) : json(res, 409, r)
  }
  const cancelHandler = (req, res) => {
    if (!guardAllowProbe(req.headers)) return json(res, 403, { ok: false, error: 'forbidden' })
    if (pending === null) return json(res, 200, { ok: true, policy: null })
    const by = pending.source
    core.logEvent('restart-cancelled', { by, id: pending.id })
    clearPending(by + '-cancel')
    return json(res, 200, { ok: true, policy: by })
  }
  const checkHandler = (req, res) => json(res, 200, { ok: true, pid: process.pid, tag: TAG })
  const logHandler = (req, res) => json(res, 200, { ok: true, lines: core.readLogTail(Number(new URL(req.url, 'http://x').searchParams.get('lines')) || 200) })
  const logOpenHandler = (req, res) => json(res, 200, { ok: true, path: core.debugLogPath() })
  const routes = [
    ['/status', mk(statusHandler)],
    ['/config', mk(configHandler)],
    ['/restart', mk(restartHandler)],
    ['/cancel', mk(cancelHandler)],
    ['/check', mk(checkHandler)],
    ['/log', mk(logHandler)],
    ['/log/open', mk(logOpenHandler)],
    ['', mk(statusHandler)],
  ]
  for (const [suffix, handler] of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `/plugins/dsh-harness-restart${suffix}`, handler }), `dsh-harness-restart v1: ${suffix || '/'} route`)
  }
}

/* ── apply ────────────────────────────────────────────────────────── */
export function apply(ctx, config) {
  setBootConfig(config || {})
  core.logEvent('restart-apply', { tag: TAG, mode: core.supervisorMode() || 'self', relaunch: core.relaunchMode() === true, pid: process.pid })
  registerRoutes(ctx)
  registerTools(ctx)
  // 250ms 心跳：调度（分钟边界）+ PRE + 回执
  const heartbeat = setInterval(() => tick(ctx), 250)
  ctx.effect(() => () => clearInterval(heartbeat))
  // 启动后恢复（POST）
  const cfg = currentConfig().config
  ctx.effect(() => () => { for (const t of restoreTimers) clearTimeout(t); restoreTimers = [] })
  setTimeout(() => scheduleRestore(ctx, cfg), Math.min(3000, Number(cfg.bootRestoreDelayMs || 60000)))
  // 0.2.0：app-boot/config-reload —— 记录配置热重载（便于诊断），客户端 /status 可见
  try {
    ctx.on('app-boot/config-reload', () => {
      lastConfigReloadAt = new Date().toISOString()
      core.logEvent('config-reloaded', { at: lastConfigReloadAt })
    })
  } catch (error) { core.debugLog(`config-reload listen failed: ${String(error)}`) }
  return { name }
}