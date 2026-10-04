/**
 * v1 回调系统：所有"策略" = 注册表回调 (now, ctx) => boolean。
 * 两档：kind=preset（官方预设纯函数）/ kind=script（用户函数体，new Function 执行，完全信任）。
 * 纯逻辑，可离线单测；宿主装配在 v1/host.js。
 */

/** 编译用户脚本为 (now, ctx) => boolean：表达式自动包 return；带 return 的按函数体原样。 */
export function compileScript(body) {
  const trimmed = String(body).trim()
  const wrapped = /^\s*return\b/m.test(trimmed) ? trimmed : `return (${trimmed})`
  return new Function('now', 'ctx', wrapped)
}

/** 官方预设定义：params 声明参数名，fn 为 (now, args, runtime) => boolean，describe 生成人话说明。 */
export const PRESETS = {
  now: {
    params: [],
    describe: () => '立即重启（手动/AI 触发，走审批与 PRE）',
    fn: () => true,
  },
  delay: {
    params: ['delayMs', 'startedAt'],
    describe: ({ delayMs }) => `等待 ${Math.round(delayMs / 1000)} 秒后重启`,
    fn: (now, args) => now.getTime() - (args.startedAt || 0) >= (args.delayMs || 0),
  },
  daily: {
    params: ['hour', 'minute'],
    describe: ({ hour, minute }) => `每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 触发`,
    fn: (now, args) => now.getHours() === args.hour && now.getMinutes() === args.minute,
  },
  weekly: {
    params: ['weekdays', 'hour', 'minute'],
    describe: ({ weekdays, hour, minute }) => `每周[${weekdays.join('/')}] ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 触发`,
    fn: (now, args) => Array.isArray(args.weekdays) && args.weekdays.includes(now.getDay()) && now.getHours() === args.hour && now.getMinutes() === args.minute,
  },
  immediate: {
    params: [],
    describe: () => '立即离开（PRE）',
    fn: () => true,
  },
  waitSeconds: {
    params: ['seconds', 'startedAt'],
    describe: ({ seconds }) => `等待 ${seconds} 秒后重启（PRE）`,
    fn: (now, args) => now.getTime() - (args.startedAt || 0) >= (args.seconds || 0) * 1000,
  },
  waitAllOrForce: {
    params: ['forceAfterMs', 'startedAt', 'idle'],
    describe: ({ forceAfterMs }) => forceAfterMs === -1 ? '等所有会话结束（无限等待，PRE）' : `等会话结束，或 ${Math.round(forceAfterMs / 1000)} 秒后强制重启（PRE）`,
    fn: (now, args) => {
      if (args.idle === true) return true
      const force = Number(args.forceAfterMs)
      if (!Number.isFinite(force) || force === -1) return false // -1 = 无限等，不强制
      return now.getTime() - (args.startedAt || 0) >= force
    },
  },
}

export function validateEntry(entry, index = 0) {
  if (entry === null || typeof entry !== 'object') return `schedule[${index}] 必须是对象`
  if (typeof entry.id !== 'string' || entry.id.trim() === '' || entry.id.length > 40) return `schedule[${index}].id 必填（≤40 字符）`
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') return `schedule[${index}].enabled 必须是布尔`
  if (entry.kind === 'preset') {
    if (typeof entry.preset !== 'string' || !(entry.preset in PRESETS)) return `schedule[${index}].preset 必须是官方预设：${Object.keys(PRESETS).join(' / ')}`
    const args = entry.args === undefined ? {} : entry.args
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return `schedule[${index}].args 必须是对象`
    for (const key of Object.keys(args)) {
      if (!PRESETS[entry.preset].params.includes(key)) return `schedule[${index}].args 包含预设 ${entry.preset} 不认识的参数「${key}」`
    }
    if (entry.preset === 'daily' || entry.preset === 'weekly') {
      if (!Number.isInteger(args.hour) || args.hour < 0 || args.hour > 23) return `schedule[${index}].args.hour 必须是 0–23 整数`
      if (!Number.isInteger(args.minute) || args.minute < 0 || args.minute > 59) return `schedule[${index}].args.minute 必须是 0–59 整数`
    }
    if (entry.preset === 'weekly' && (!Array.isArray(args.weekdays) || args.weekdays.length === 0 || args.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
      return `schedule[${index}].args.weekdays 必须是 0–6 整数数组`
    }
    return null
  }
  if (entry.kind === 'script') {
    if (typeof entry.script !== 'string' || entry.script.trim() === '') return `schedule[${index}].script 必填`
    if (entry.script.length > 5000) return `schedule[${index}].script 过长（≤5000 字符）`
    try { compileScript(entry.script) } catch (error) {
      return `schedule[${index}].script 编译失败：${String(error && error.message || error).slice(0, 120)}`
    }
    return null
  }
  return `schedule[${index}].kind 必须是 preset / script`
}

/**
 * 编译回调为可调用函数。
 * @param {object} entry 已验证条目
 * @param {{onError?: (e: object) => void}} [opts]
 * @returns {(now: Date, ctx: object, runtime?: object) => boolean}
 */
export function makeCallback(entry, opts = {}) {
  if (entry.kind === 'preset') {
    const def = PRESETS[entry.preset]
    const args = { ...(entry.args || {}) }
    return (now, ctx, runtime) => {
      try {
        return def.fn(now, { ...args, ...(runtime || {}) }, ctx) === true
      } catch (error) {
        if (opts.onError) opts.onError({ entryId: entry.id, preset: entry.preset, error: String(error && error.message || error) })
        return false
      }
    }
  }
  // kind=script：完全信任（等同管理员权限），宿主执行；异常视为 false 并报告。
  let fn
  try { fn = compileScript(entry.script) } catch (error) {
    if (opts.onError) opts.onError({ entryId: entry.id, kind: 'script', error: String(error && error.message || error) })
    return () => false
  }
  return (now, ctx, runtime) => {
    try {
      const result = fn(now, { ...ctx, ...(runtime || {}) })
      return result === true
    } catch (error) {
      if (opts.onError) opts.onError({ entryId: entry.id, kind: 'script', error: String(error && error.message || error) })
      return false
    }
  }
}

/** 编译一组条目（不抛错，逐个报 onError）。 */
export function compileAll(entries, opts = {}) {
  const out = new Map()
  for (const entry of entries) {
    if (entry.enabled === false) continue
    const err = validateEntry(entry)
    if (err !== null) { if (opts.onError) opts.onError({ entryId: entry.id, error: err }); continue }
    out.set(entry.id, makeCallback(entry, opts))
  }
  return out
}

/**
 * 求值：返回第一个返回 true 的条目（注册顺序）。
 * @param {Map<string, (now,ctx,runtime)=>boolean>} compiled
 * @param {Date} now
 * @param {object} ctx 只读上下文
 * @param {object} [runtime] 运行期补充（preset 用：startedAt/idle 等）
 * @returns {string|null} 命中条目 id
 */
export function evaluateFirst(compiled, now, ctx, runtime = {}) {
  for (const [id, fn] of compiled) {
    try {
      if (fn(now, ctx, runtime) === true) return id
    } catch { /* makeCallback 已兜底 */ }
  }
  return null
}

/** 人话说明（设置页展示）。 */
export function describe(entry) {
  if (entry.kind === 'script') return '自定义脚本回调（完全信任，危险）'
  const def = PRESETS[entry.preset]
  return def.describe(entry.args || {})
}