/**
 * v1 PRE 层（纯函数）：重启前策略 immediate / waitSeconds / waitAllOrForce(-1 无限)。
 * 判定语义与 v0.1.0 的 idle 判定一致（根会话无 running turn = 空闲）。
 */

/**
 * 重启前策略判定："现在该离开了吗"。
 * @param {Date} now
 * @param {{mode: string, forceAfterMs: number}} pre
 * @param {{startedAt: number, idle: boolean}} state preStartedAt + 当前是否全部空闲
 * @returns {boolean}
 */
export function preDone(now, pre, state) {
  const elapsed = now.getTime() - state.startedAt
  switch (pre.mode) {
    case 'immediate':
      return elapsed >= 0
    case 'waitSeconds': {
      // waitSeconds 的时间由触发层（delay）承担；此处模式语义：配置的 forceAfterMs 当作秒
      const seconds = (pre && pre.forceAfterMs !== undefined) ? pre.forceAfterMs : 0
      return elapsed >= (seconds >= 0 ? seconds : 0) * 1000 // 秒 → 毫秒，勿再与 elapsed(ms) 直接比
    }
    case 'waitAllOrForce':
      if (state.idle === true) return true
      const force = Number(pre.forceAfterMs)
      if (!Number.isFinite(force) || force === -1) return false // -1 = 无限等
      return elapsed >= force
    default:
      return false
  }
}

/** 重启前策略的人话说明（设置页展示）。 */
export function describePre(pre) {
  if (pre.mode === 'immediate') return '立即离开'
  if (pre.mode === 'waitSeconds') return `等待 ${pre.forceAfterMs ?? 0} 秒后离开`
  if (pre.forceAfterMs === -1) return '等所有会话结束（无限等待）'
  return `等会话结束，或 ${Math.round((pre.forceAfterMs ?? 30000) / 1000)} 秒后强制离开`
}