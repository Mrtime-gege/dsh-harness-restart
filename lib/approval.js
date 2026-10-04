/**
 * v1 APPROVAL 层（纯函数）：AI 两段式挑战（沿用旧语义迁移）+ 权限 + 触发参数校验。
 * 语义：参数不匹配/越界一律报错，绝不静默钳制。
 */

import { randomBytes } from 'node:crypto'

/** 生成 16 位一次性认证串。 */
export function issueChallenge(extraSeed = '') {
  return randomBytes(8).toString('hex') + String(extraSeed).slice(0, 2)
}

/**
 * AI 触发参数校验（now/delay）。
 * @param {{trigger?: string, delayMs?: number}} params
 * @param {{allowNow: boolean, delayRangeMs: [number, number], recommendDelayMs: number}} ai
 * @returns {{ok: true, trigger: string, delayMs?: number} | {ok: false, error: string}}
 */
export function sanitizeAiTrigger(params, ai) {
  const trigger = params.trigger || 'delay'
  if (trigger === 'now') {
    if (ai.allowNow !== true) return { ok: false, error: 'AI 发起立即重启已被禁用（ai.allowNow=false）；请改用 delay（等待后重启）' }
    return { ok: true, trigger: 'now' }
  }
  if (trigger !== 'delay') return { ok: false, error: 'trigger 必须是 now / delay' }
  const ms = Number(params.delayMs)
  const [min, max] = ai.delayRangeMs || [180000, 3600000]
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < min || ms > max) {
    const recommend = ai.recommendDelayMs || 300000
    return { ok: false, error: `delayMs 必须在 ${min}~${max} 毫秒之间（${Math.round(min / 60000)} 分钟 ~ ${Math.round(max / 3600000)} 小时）；推荐 ${Math.round(recommend / 60000)} 分钟（${recommend}ms）` }
  }
  return { ok: true, trigger: 'delay', delayMs: ms }
}

/** 用户/命令/定时侧的 delay 校验（0~24h，0 视为 now）。 */
export function sanitizeManualTrigger(params) {
  const trigger = params.trigger || 'delay'
  if (trigger === 'now') return { ok: true, trigger: 'now' }
  if (trigger !== 'delay') return { ok: false, error: 'trigger 必须是 now / delay' }
  const ms = Number(params.delayMs)
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < 0 || ms > 86400000) {
    return { ok: false, error: `delayMs 必须在 0~86400000 毫秒之间（0 = 立即）` }
  }
  return { ok: true, trigger: 'delay', delayMs: ms === 0 ? undefined : ms }
}