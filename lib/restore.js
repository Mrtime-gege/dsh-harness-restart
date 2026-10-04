/**
 * v1 POST/恢复层（纯函数）：重启后策略 + 恢复回调（方案 B 渐进恢复 + 回执超时）的编排纯逻辑。
 * 宿主负责实际注入；这里只做"队列与时机"的计算，可离线单测。
 */

/**
 * 计算"重启后恢复计划"的执行序列。
 * @param {object} plan 恢复计划：{unfinished: string[], requester?: string, callbacks: Array<{callbackId, sessionId, description, selfPrompt, resumeToken}>}
 * @param {{mode?: string, bootRestoreDelayMs?: number, restoreStaggerMs?: number}} post cfg.postRestart + 渐进参数
 * @param {number} now 重启完成时刻（ms）
 * @returns {{ mode: string, resumeTargets: Array<{sessionId, why:'requester'|'unfinished', at: number}>, callbackQueue: Array<{cb, at: number}> }}
 */
export function planRestore(plan, post, now) {
  const mode = (post && post.mode) || 'none'
  const bootDelay = Number(post && post.bootRestoreDelayMs) || 60000
  const stagger = Number(post && post.restoreStaggerMs) || 5000

  const resumeTargets = []
  if (mode === 'resumeRequester' && typeof plan.requester === 'string' && plan.requester !== '') {
    resumeTargets.push({ sessionId: plan.requester, why: 'requester', at: now })
  } else if (mode === 'resumeAll') {
    for (const sessionId of plan.unfinished || []) {
      if (typeof sessionId === 'string' && sessionId !== '') resumeTargets.push({ sessionId, why: 'unfinished', at: now })
    }
  }
  const callbackQueue = []
  const callbacks = Array.isArray(plan.callbacks) ? plan.callbacks : []
  for (const cb of callbacks) {
    callbackQueue.push({ cb, at: now + bootDelay + callbackQueue.length * stagger })
  }
  return { mode, resumeTargets, callbackQueue }
}

/** 回执状态转移：pending → (超时) → reminded → (再超时) → unacked。纯函数。 */
export function tickReceipts(receipts, now, timeoutMs) {
  const due = []
  for (const r of receipts) {
    if (r.status === 'done') continue
    if (r.status === 'pending' && now - r.restoredAt >= timeoutMs) {
      r.status = 'reminded'
      due.push({ ...r, kind: 'reminder-1' })
    } else if (r.status === 'reminded' && now - r.remindedAt >= timeoutMs) {
      r.status = 'unacked'
      due.push({ ...r, kind: 'unacked' })
    }
  }
  return due
}

/** 恢复注入文案：默认恢复提示（{cbId}/{description} 占位） + selfPrompt（可选）。 */
export function buildRestoreText(restorePrompt, cb, selfPromptLimit = 500) {
  let text = (restorePrompt || '').replace(/\{cbId\}/g, cb.callbackId).replace(/\{description\}/g, cb.description || '')
  if (typeof cb.selfPrompt === 'string' && cb.selfPrompt.trim() !== '') {
    const self = cb.selfPrompt.trim()
    text += '\n' + (self.length > selfPromptLimit ? self.slice(0, selfPromptLimit) : self)
  }
  return text
}