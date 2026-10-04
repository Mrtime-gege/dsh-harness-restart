## 子 agent 覆盖 + 混沌矩阵（2026-10）

- **子 agent 场景**：idleSnapshot/collectUnfinished 从 `agents.roots()` 改为 `agents.list()`（0.2.0 全量 live agent，含 subagent 子会话、Agent Teams teammate），重启等待与恢复计划均覆盖子 agent；list() 与 roots() 双兼容（dedup by session.id）
- helper 自愈加固：端口被**非健康** TCP 占用（残留进程）不再误判让位 —— 只有探测到健康 dsh（/status 200）才让位，否则继续重试拉起
- 混沌矩阵 scripts/chaos-matrix.sh（9 场景，真实故障注入，全部隔离实例）：基线闭环 / 三轮连续重启 / kill -9 异常倒下 / 非健康端口占用 / 并发单飞行 409 / helper 文件被删 / 损坏 marker / 损坏配置 / 演练模式
- Config schema 显式声明自定义字段（schemastery 原生语法，无 z.enum/.optional），修复 z.object strip 导致 simulateOnly 等失效；postRestart 空对象宽容（cordis 注入 {}）
- simulateOnly 校验通过后真正赋值到输出 config

## 0.2.0 新机制接入 + 重启双保险（2026-10）

- 接入 `agent/created` 事件（含 SessionStartSource）：会话恢复为 live 时立即注入恢复提示（事件驱动），原定时器作兜底，injected 集合去重防重复注入
- 接入 `app-boot/config-reload`：记录配置热重载（/status 可见 lastConfigReloadAt）
- **重启保证强化（双保险）**：finalize 无论 self/supervisor 一律先挂自愈 helper + 退出让出端口；helper 升级为四阶段——端口释放等待（≤60s）→ 他人接管则让位（systemd 已拉起时退出）→ 自拉起 + 健康探测（30s）→ 失败最多 3 次重试；失败写 relaunch-failed 日志
- 修复：helper targetPort 从注入 dsh argv 提取（此前误探测 3080 导致重启不生效）；TDZ（targetPort 先于使用初始化）；status 引用模块级变量
- 验证：test:e2e（真实闭环 10/10）、test:simulate（演练 11/11）、单元 72+11 断言

## 兼容 dsh 0.2.0-rc.2（2026-10）

- `sessionController.prompt` 适配 0.2.0 契约：`prompt({requestId, sessionId, mode, content[]})`，失败自动回退 0.1.x 老签名 `prompt(sessionId, text)`
- 客户端槽位注册契约 `title` → `label`（0.2.0 要求 `label`，两者同时声明以兼容 0.1.x）；settings.section / shell.overlay 均带 label
- 核对兼容面：`webServer.register({kind:'exact'})`、`ctx.tools.register(defineTool)`、`Config = z.object({})`、peer（cordis ^4.0.2 / dsh-tools >=rc.1 / schemastery ^3.18.0）在 0.2.0-rc.2（cordis 4.0.4 / dsh-tools 0.2.0-rc.2 / schemastery 3.18.4）下全部满足
- 0.2.0 新机制盘点（观察结论）：官方 `agents.resume()` + `SessionStartSource`('startup'|'resume'|'clear'|'compact')、`agent/created` 事件、`schedule` 服务、`webhookRuntime`、`app-boot/config-reload`、`clientModules.onRebuilt`、`tools/change` 事件——与插件当前自研重启/渐进恢复架构语义不重复，记录备选，暂不引入

## [0.1.0] — v1.0 引擎重写（2026-09）

四层架构：TRIGGER(now/delay/schedule 回调) → APPROVAL(挑战/权限/AI 区间 3min~1h) → PRE(immediate/waitSeconds/waitAllOrForce,-1 无限) → EXIT(复用 core) → POST(none/resumeRequester/resumeAll + 恢复回调方案 B：1min+5s 渐进 + 回执超时)。
- 策略=回调：官方预设（now/delay/daily/weekly/immediate/waitSeconds/waitAllOrForce）+ script 自定义（完全信任+告警+异常兜底）
- 新增工具：dsh_restart_register_callback(description≤200, selfPrompt≤500) / dsh_restart_callback_done(resumeToken)
- 前缀统一【DSH 重启】；restorePrompt 可配 + selfPrompt 拼接
- 配置解耦：$DSH_HOME/dsh-harness-restart-v1.json 覆盖，严格校验不钳制、越界回退+告警
- 修复：client 槽位注册契约（inject+descriptor.name）、PRE immediate 尊重 delay 等待、pre.js waitSeconds 单位、调度改分钟边界检测（抗抖动）

# Changelog

本项目采用 **[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)** 与语义化版本。  
发布物（npm tarball 与 `release` 分支）只包含插件本体；以下条目记录完整演进（`dev` 分支）。

## [0.1.0] - 首个公开版本基线

版本号自此重置为 0.1.0（此前内部演进 0.1.0→0.3.5 已并入此基线）。

### 新增
- 设置页「DSH 重启」整页：权限（置顶）→ 重启+策略（合并置底）→ 日志（最下）
- 三种重启策略：`now`（页面）/ `wait-idle` / `notify`；等待类实时进度 + 取消 + 右下角非阻塞倒计时小窗（显示发起方与剩余时间）
- AI 两段式挑战认证：16 位一次性认证串 + **`policy` 绑定**（二次调用必须与首次完全一致）；AI 禁用 `now`；等待类硬性 ≥3 分钟
- `dsh_restart_cancel` 工具：仅取消 AI 发起的等待
- 「允许 AI 使用重启」「AI 发起重启需要二次认证」开关（服务端强制）
- 重启后自动继续（进行中 turn ∪ 活动 goal；followup + `sessionController.prompt` 兜底）
- 凭证轮换自愈：探针路由下发新进程 `authenticatedUrl()`，页面自动重开（按钮与 AI 双路径）
- 日志卡：实时尾部 + 一键打开源文件；记录 AI 重启/被拒/认证/等待/取消事件
- 环境自适应重启：systemd（`INVOCATION_ID` + `/system.slice/` cgroup 判定）/ 容器 / 裸跑 detach helper（Windows 隐藏控制台）
- 参数严格校验：越界报错、绝不静默钳制
- 定时重启：`schedule` 条目数组，到点按指定策略自动触发（页面级、可取消、同一分钟不重复）

### 修复
- 自（bare-run）模式旧进程未按时退出导致 helper 抢占端口失败（隔离实例实测发现）
- 设置页策略单选「点了无法选中」（配置回读时序 → 服务端合并回显 + 客户端乐观选中）
- client 半必须用 `window.__ModuleLoader__.load` 注册（早期 `module.exports` 无效）
- supervisor 检测误判（用户级 scope 的 `INVOCATION_ID` 不应视为 systemd 单元）

### 兼容
- 已实测基线：`dsh 0.1.5-rc.1`（声明 `dsh.engines.dsh >= 0.1.5-rc.1`）
- 依赖全部可选 peer，运行时单副本解析（见 README「依赖」）

[0.1.0]: https://github.com/<owner>/dsh-harness-restart/releases/tag/v0.1.0