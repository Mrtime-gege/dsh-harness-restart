/**
 * v1 配置模型（重写版，不兼容 v0.1.0）。
 * 纯函数：validateConfigV1(raw) -> {ok:true, config:{…}} | {ok:false, error}
 * 语义：越界一律报错，绝不静默钳制；未知键报错；合并 DEFAULTS。
 */

/** 编译探测用户脚本（表达式自动包 return；带 return 的按函数体）。 */
function compileScriptSafe(body) {
  const trimmed = String(body).trim()
  const wrapped = /^\s*return\b/m.test(trimmed) ? trimmed : `return (${trimmed})`
  return new Function('now', 'ctx', wrapped)
}

export const TRIGGERS = new Set(['now', 'delay'])
export const PRE_MODES = new Set(['immediate', 'waitSeconds', 'waitAllOrForce'])
export const POST_MODES = new Set(['none', 'resumeRequester', 'resumeAll'])
export const TAG = '【DSH 重启】'

export const DEFAULTS = {
  ai: {
    restartEnabled: true,
    challengeEnabled: true,
    allowNow: false,
    delayRangeMs: [180000, 3600000], // AI delay 参数区间：3 分钟 ~ 1 小时
    recommendDelayMs: 300000,        // 推荐 5 分钟
  },
  trigger: {
    defaultTrigger: 'delay',         // schedule 命中时的默认触发
    defaultDelayMs: 300000,
  },
  schedule: [],
  preRestart: { mode: 'waitAllOrForce', forceAfterMs: 30000 },
  postRestart: { mode: 'resumeAll' },
  restartDelayMs: 2000,
  challengeTtlMs: 300000,
  bootRestoreDelayMs: 60000,         // 重启后回调渐进恢复：首个等待（默认 1 分钟）
  restoreStaggerMs: 5000,            // 之后每 x 秒启动一个（默认 5 秒）
  callbackUnackTimeoutMs: 1800000,   // 方案 B 回执超时（默认 30 分钟）
  autoResumeCallbacks: false,        // 方案 D 开关（默认关，本版不实现）
  simulateOnly: false,               // 演练模式：finalize 不真重启（不 exit/不拉起），事件链与恢复照常走。=true 或环境变量 DSH_RESTART_SIMULATE=1
  notifyPrompt: '【DSH 重启】DSH 将在约 {minutes} 分钟后重启，请尽快收尾。',
  continuePrompt: '【DSH 重启】已重启完成。请按重启后策略恢复之前的工作。',
  restorePrompt: '【DSH 重启】已重启。你注册的回调 {cbId}（{description}）已恢复，自动继续之前的任务。',
  logTailLines: 300,
}

function isBool(v) { return typeof v === 'boolean' }
function isIntIn(v, min, max) { return Number.isInteger(v) && v >= min && v <= max }

/** 校验并规范化一条调度回调条目（结构层；行为由 v1/callbacks.js 解析）。 */
function validateScheduleItem(item, index) {
  if (item === null || typeof item !== 'object') return `schedule[${index}] 必须是对象`
  if (typeof item.id !== 'string' || item.id.trim() === '' || item.id.length > 40) return `schedule[${index}].id 必填（≤40 字符）`
  if (item.kind !== 'preset' && item.kind !== 'script') return `schedule[${index}].kind 必须是 preset / script`
  if (item.kind === 'preset') {
    if (typeof item.preset !== 'string' || item.preset === '') return `schedule[${index}].preset 必填`
    if (item.args !== undefined && (item.args === null || typeof item.args !== 'object' || Array.isArray(item.args))) return `schedule[${index}].args 必须是对象`
  } else {
    if (typeof item.script !== 'string' || item.script.trim() === '') return `schedule[${index}].script 必填`
    if (item.script.length > 5000) return `schedule[${index}].script 过长（≤5000 字符）`
    try { compileScriptSafe(item.script) } catch (error) {
      return `schedule[${index}].script 编译失败：${String(error && error.message || error).slice(0, 120)}`
    }
  }
  return null
}

function validateAi(value, errors) {
  if (value === null || typeof value !== 'object') { errors.push('ai 必须是对象'); return null }
  const out = {}
  if (value.restartEnabled !== undefined && !isBool(value.restartEnabled)) { errors.push('ai.restartEnabled 必须是布尔'); return null }
  if (value.challengeEnabled !== undefined && !isBool(value.challengeEnabled)) { errors.push('ai.challengeEnabled 必须是布尔'); return null }
  if (value.allowNow !== undefined && !isBool(value.allowNow)) { errors.push('ai.allowNow 必须是布尔'); return null }
  if (value.delayRangeMs !== undefined) {
    const r = value.delayRangeMs
    if (!Array.isArray(r) || r.length !== 2 || !isIntIn(r[0], 0, 86400000) || !isIntIn(r[1], 0, 86400000) || r[1] < r[0]) {
      errors.push('ai.delayRangeMs 必须是 [min,max]（0~86400000 的整数，max≥min）')
      return null
    }
    out.delayRangeMs = [r[0], r[1]]
  }
  if (value.recommendDelayMs !== undefined) {
    if (!isIntIn(value.recommendDelayMs, 0, 86400000)) { errors.push('ai.recommendDelayMs 超出范围 0~86400000'); return null }
    out.recommendDelayMs = value.recommendDelayMs
  }
  return { restartEnabled: value.restartEnabled, challengeEnabled: value.challengeEnabled, allowNow: value.allowNow, ...out }
}

/**
 * 旧版（v0.1.0）平铺键 → v1 嵌套键映射。
 * 让旧客户端/旧配置写法在 v1 宿主下仍能工作，平滑过渡。
 */
const LEGACY_KEY_MAP = {
  aiRestartEnabled: (v) => ({ ai: { restartEnabled: v } }),
  aiRestartChallenge: (v) => ({ ai: { challengeEnabled: v } }),
  aiAllowNowPolicy: (v) => ({ ai: { allowNow: v } }),
  aiMinCountdownMs: (v) => ({ ai: { delayRangeMs: [v, 3600000] } }),
  restartPolicy: (v) => ({ trigger: { defaultTrigger: v === 'now' ? 'now' : 'delay' } }),
  waitIdleTimeoutMs: (v) => ({ preRestart: { forceAfterMs: v } }),
  notifyWaitMs: (v) => ({ trigger: { defaultDelayMs: v } }),
  notifyRestartWhenIdle: () => ({}), // v1 移除
  pageMinCountdownMs: () => ({}),   // v1 移除
}

export function normalizeLegacyKeys(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const result = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key in LEGACY_KEY_MAP) {
      const mapped = LEGACY_KEY_MAP[key](value)
      for (const [k, v] of Object.entries(mapped)) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          result[k] = { ...(result[k] || {}), ...v }
        } else {
          result[k] = v
        }
      }
    } else {
      result[key] = value
    }
  }
  return result
}

export function validateConfigV1(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '配置必须是对象' }
  raw = normalizeLegacyKeys(raw)
  const errors = []
  const config = structuredClone(DEFAULTS)

  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULTS)) errors.push(`未知配置项「${key}」`)
  }
  if (errors.length > 0) return { ok: false, error: `配置无效：${errors.join('；')}` }

  const v = raw
  if (v.ai !== undefined) { const ai = validateAi(v.ai, errors); if (ai !== null) config.ai = { ...config.ai, ...ai } }
  if (v.trigger !== undefined) {
    const t = v.trigger
    if (t !== null && typeof t === 'object') {
      if (t.defaultTrigger !== undefined && !TRIGGERS.has(t.defaultTrigger)) errors.push('trigger.defaultTrigger 必须是 now / delay')
      else if (t.defaultTrigger !== undefined) config.trigger.defaultTrigger = t.defaultTrigger
      if (t.defaultDelayMs !== undefined && !isIntIn(t.defaultDelayMs, 0, 86400000)) errors.push('trigger.defaultDelayMs 超出范围 0~86400000')
      else if (t.defaultDelayMs !== undefined) config.trigger.defaultDelayMs = t.defaultDelayMs
    } else errors.push('trigger 必须是对象')
  }
  if (v.schedule !== undefined) {
    if (!Array.isArray(v.schedule)) { errors.push('schedule 必须是数组') }
    else {
      const entries = []
      let bad = null
      for (let i = 0; i < v.schedule.length; i++) { bad = validateScheduleItem(v.schedule[i], i); if (bad) break; entries.push(v.schedule[i]) }
      if (bad) errors.push(bad)
      else config.schedule = entries
    }
  }
  if (v.preRestart !== undefined) {
    const p = v.preRestart
    if (p !== null && typeof p === 'object') {
      if (p.mode !== undefined && !PRE_MODES.has(p.mode)) errors.push('preRestart.mode 必须是 immediate / waitSeconds / waitAllOrForce')
      else if (p.mode !== undefined) config.preRestart.mode = p.mode
      if (p.forceAfterMs !== undefined) {
        if (!Number.isInteger(p.forceAfterMs) || p.forceAfterMs < -1 || p.forceAfterMs > 86400000) errors.push('preRestart.forceAfterMs 必须是 ≥-1 的整数（-1=无限，单位 ms）')
        else config.preRestart.forceAfterMs = p.forceAfterMs
      }
    } else errors.push('preRestart 必须是对象')
  }
  if (v.postRestart !== undefined) {
    if (v.postRestart === null || (typeof v.postRestart === 'object' && Object.keys(v.postRestart).length === 0)) {
      // cordis Config 对未提供字段注入空对象 {}：视为未配置，保留默认
    } else if (v.postRestart !== null && typeof v.postRestart === 'object' && typeof v.postRestart.mode === 'string' && POST_MODES.has(v.postRestart.mode)) config.postRestart = { mode: v.postRestart.mode }
    else if (typeof v.postRestart === 'string' && POST_MODES.has(v.postRestart)) config.postRestart = { mode: v.postRestart }
    else errors.push('postRestart 必须是 none / resumeRequester / resumeAll（或 {mode}）')
  }
  const NUM = [['restartDelayMs', 0, 60000], ['challengeTtlMs', 30000, 3600000], ['bootRestoreDelayMs', 0, 86400000], ['restoreStaggerMs', 100, 3600000], ['callbackUnackTimeoutMs', 60000, 86400000], ['logTailLines', 20, 2000]]
  for (const [key, min, max] of NUM) {
    if (v[key] !== undefined) {
      if (!isIntIn(v[key], min, max)) errors.push(`「${key}」超出范围 ${min}~${max}`)
      else config[key] = v[key]
    }
  }
  for (const key of ['notifyPrompt', 'continuePrompt', 'restorePrompt']) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== 'string' || v[key].trim().length < 1 || v[key].length > 2000) errors.push(`「${key}」必须是非空字符串（≤2000 字符）`)
      else config[key] = v[key].trim()
    }
  }
  if (v.autoResumeCallbacks !== undefined && !isBool(v.autoResumeCallbacks)) errors.push('autoResumeCallbacks 必须是布尔')
  else if (v.autoResumeCallbacks !== undefined) config.autoResumeCallbacks = v.autoResumeCallbacks
  if (v.simulateOnly !== undefined && !isBool(v.simulateOnly)) errors.push('simulateOnly 必须是布尔')
  else if (v.simulateOnly !== undefined) config.simulateOnly = v.simulateOnly

  if (errors.length > 0) return { ok: false, error: `配置无效：${errors.join('；')}` }
  return { ok: true, config }
}