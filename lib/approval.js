/**
 * v1.1 APPROVAL 决策引擎：AI 控制 / 人类控制 双维权限。
 *
 * 设计见 docs/PERMISSIONS.md：
 *   permissions.ai    — AI 工具通道（enabled/challenge/humanConfirm/triggers/delayRange/频控/窗口）
 *   permissions.human — 人类通道（enabled/sources/challenge/triggers/delayRange/频控）
 *   permissions.cross — 公共（PRE 归属/演练模式/审计）
 *
 * 约定：参数不匹配/越界一律报错，绝不静默钳制；所有拒绝可写审计事件（由调用方 logDenials 决定）。
 */

import { randomBytes } from 'node:crypto'

/* ── 挑战 ─────────────────────────────────────────────────────────── */
/** 生成 16 位一次性认证串。 */
export function issueChallenge(extraSeed = '') {
  return randomBytes(8).toString('hex') + String(extraSeed).slice(0, 2)
}

/* ── 频控/冷却：进程内分钟桶（每个通道独立计数）───────────────────── */
const buckets = new Map() // key: `${channel}:${minuteKey}` → count
function minuteKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}
function consumeRate(channel, maxPerHour) {
  if (!(maxPerHour > 0)) return true // 0 = 不限
  const k = `${channel}:${minuteKey(Date.now())}`
  const n = (buckets.get(k) || 0) + 1
  buckets.set(k, n)
  if (buckets.size > 3000) buckets.clear() // 自卫：防无限增长
  return n <= maxPerHour
}
/** last-at 冷却记录 */
const lastAt = new Map() // channel → ts
function checkCooldown(channel, cooldownMs) {
  if (!(cooldownMs > 0)) return { ok: true }
  const prev = lastAt.get(channel)
  const now = Date.now()
  if (prev !== undefined && now - prev < cooldownMs) {
    return { ok: false, error: `操作过于频繁：请等 ${Math.round((cooldownMs - (now - prev)) / 1000)} 秒后再试` }
  }
  lastAt.set(channel, now)
  return { ok: true }
}

/* ── 时段窗口 ─────────────────────────────────────────────────────── */
function inWindow(windows, now = new Date()) {
  if (!Array.isArray(windows) || windows.length === 0) return true
  const hm = now.getHours() * 60 + now.getMinutes()
  return windows.some((w) => {
    const [fh, fm] = String(w.from || '00:00').split(':').map(Number)
    const [th, tm] = String(w.to || '23:59').split(':').map(Number)
    const from = (fh || 0) * 60 + (fm || 0)
    const to = (th || 23) * 60 + (tm || 59)
    if (from <= to) return hm >= from && hm <= to
    return hm >= from || hm <= to // 跨午夜
  })
}

/* ── AI 触发决策 ──────────────────────────────────────────────────── */
/**
 * @param {{trigger?: string, delayMs?: number}} params
 * @param {{enabled:boolean, challenge:boolean, humanConfirm:boolean, confirmTtlMs:number, triggers:{now:boolean},
 *          delayRangeMs:[number,number], recommendDelayMs:number, maxPerHour:number, cooldownMs:number,
 *          windows:Array}} ai
 */
export function evaluateAiTrigger(params, ai) {
  const trig = params.trigger || 'delay'
  if (ai.enabled !== true) return { ok: false, reason: 'ai-denied', error: 'AI 发起重启已禁用（permissions.ai.enabled=false）' }
  const now = new Date()
  if (!inWindow(ai.windows || [], now)) return { ok: false, reason: 'off-window', error: '当前不在 AI 允许的时段窗口内（permissions.ai.windows）' }

  const cooldown = checkCooldown('ai', ai.cooldownMs)
  if (!cooldown.ok) { consumeRate('ai', ai.maxPerHour); return { ok: false, reason: 'ai-cooldown', error: cooldown.error } }
  if (!consumeRate('ai', ai.maxPerHour)) return { ok: false, reason: 'ai-rate-limited', error: `AI 每小时最多发起 ${ai.maxPerHour} 次重启（permissions.ai.maxPerHour）` }

  if (trig === 'now') {
    if (ai.triggers?.now !== true) return { ok: false, reason: 'ai-now-denied', error: 'AI 发起立即重启已被禁用（permissions.ai.triggers.now=false）；请改用 delay（等待后重启）' }
    return { ok: true, trigger: 'now', needConfirm: ai.humanConfirm === true }
  }
  if (trig !== 'delay') return { ok: false, reason: 'bad-trigger', error: 'trigger 必须是 now / delay' }
  const ms = Number(params.delayMs)
  const [min, max] = ai.delayRangeMs || [180000, 3600000]
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < min || ms > max) {
    const recommend = ai.recommendDelayMs || 300000
    return { ok: false, reason: 'out-of-range', error: `delayMs 必须在 ${min}~${max} 毫秒之间（${Math.round(min / 60000)} 分钟 ~ ${Math.round(max / 3600000)} 小时）；推荐 ${Math.round(recommend / 60000)} 分钟（${recommend}ms）` }
  }
  return { ok: true, trigger: 'delay', delayMs: ms, needConfirm: ai.humanConfirm === true }
}

/* ── 人类触发决策 ─────────────────────────────────────────────────── */
/**
 * @param {{trigger?: string, delayMs?: number}} params
 * @param {{enabled:boolean, sources:object, challenge:boolean, triggers:{now:boolean},
 *          delayRangeMs:[number,number], maxPerHour:number, cooldownMs:number}} human
 * @param {'settingsPage'|'http'|'command'} source
 */
export function evaluateHumanTrigger(params, human, source = 'http') {
  if (human.enabled !== true) return { ok: false, reason: 'human-denied', error: '人类重启通道已禁用（permissions.human.enabled=false）' }
  const sources = human.sources || {}
  if (source && sources[source] === false) return { ok: false, reason: 'source-denied', error: `该入口（${source}）已被禁用（permissions.human.sources.${source}=false）` }

  const cooldown = checkCooldown(`human:${source}`, human.cooldownMs)
  if (!cooldown.ok) { consumeRate(`human:${source}`, human.maxPerHour); return { ok: false, reason: 'human-cooldown', error: cooldown.error } }
  if (!consumeRate(`human:${source}`, human.maxPerHour)) return { ok: false, reason: 'human-rate-limited', error: `人类通道每小时最多 ${human.maxPerHour} 次（permissions.human.maxPerHour）` }

  const trig = params.trigger || 'delay'
  if (trig === 'now') {
    if (human.triggers?.now !== true) return { ok: false, reason: 'human-now-denied', error: '人类立即重启已禁用（permissions.human.triggers.now=false）' }
    return { ok: true, trigger: 'now', needChallenge: human.challenge === true }
  }
  if (trig !== 'delay') return { ok: false, reason: 'bad-trigger', error: 'trigger 必须是 now / delay' }
  const ms = Number(params.delayMs)
  const [min, max] = human.delayRangeMs || [0, 86400000]
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < min || ms > max) {
    return { ok: false, reason: 'out-of-range', error: `delayMs 必须在 ${min}~${max} 毫秒之间` }
  }
  return { ok: true, trigger: 'delay', delayMs: ms === 0 ? undefined : ms, needChallenge: human.challenge === true }
}

/* ── 兼容入口（旧 API 名，新语义）────────────────────────────────── */
/* 旧 ai.* 结构 → permissions.ai 结构映射（兼容 v1 调用方与旧测试） */
export function normalizeLegacyAi(ai) {
  if (!ai) ai = {}
  return {
    enabled: ai.enabled !== undefined ? ai.enabled : true,
    challenge: ai.challenge !== undefined ? ai.challenge : (ai.challengeEnabled === true),
    humanConfirm: ai.humanConfirm === true,
    confirmTtlMs: ai.confirmTtlMs || 120000,
    triggers: { now: (ai.triggers && ai.triggers.now !== undefined) ? ai.triggers.now : (ai.allowNow === true) },
    delayRangeMs: ai.delayRangeMs || [180000, 3600000],
    recommendDelayMs: ai.recommendDelayMs || 300000,
    maxPerHour: ai.maxPerHour || 0,
    cooldownMs: ai.cooldownMs || 0,
    windows: ai.windows || [],
    cancelOwn: ai.cancelOwn !== false,
    cancelByHuman: ai.cancelByHuman !== false,
  }
}
export const sanitizeAiTrigger = (params, ai) => {
  const v = evaluateAiTrigger(params, normalizeLegacyAi(ai))
  return v.ok ? v : { ok: false, error: v.error }
}
export const sanitizeManualTrigger = (params, human, source) => {
  // 旧调用（不传 human）→ 宽松默认（等价 v1 人类行为）
  const h = human || { enabled: true, sources: { settingsPage: true, http: true, command: true }, challenge: false, triggers: { now: true }, delayRangeMs: [0, 86400000], maxPerHour: 0, cooldownMs: 0 }
  const v = evaluateHumanTrigger(params, h, source)
  return v.ok ? v : { ok: false, error: v.error }
}