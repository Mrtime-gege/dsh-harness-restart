# dsh-harness-restart

**重启整个 DeepSeek Harness（dsh）进程并自动继续未完成工作**的宿主插件：AI 发起重启需审批门禁、支持定时/脚本回调、重启后按**方案 B（回执式）渐进恢复**已注册回调的会话、内置**演练模式**（不真重启）、以及一套 supervisor 与裸跑都能用的**自愈双保险重启路径**。

基于 **dsh 0.2.0** 构建并验证（在 0.2.0-rc.2 上全量测试；旧 v0.1.x 平铺配置键自动兼容映射）。

---

## 特性

- **四层重启引擎** —— TRIGGER → APPROVAL → PRE → EXIT → POST：
  1. **触发**：页面按钮 / HTTP / AI 工具 / 定时回调（官方预设 `now` / `delay` / `daily` / `weekly` / `immediate` / `waitSeconds` / `waitAllOrForce`，以及用户**自定义 JavaScript 回调**——完全信任并带强告警与审计）。
  2. **审批**：AI 发起的重启需两段式挑战（16 位 hex token 必须原样复述）；AI 只能用 `delay` 且落在 `ai.delayRangeMs`（默认 3 分钟~1 小时）内，`now` 默认关闭。
  3. **PRE**：何时真正离开 —— `immediate` / `waitSeconds(N)` / `waitAllOrForce`（等空闲加超时强断，`-1` = 无限等）。空闲快照通过 `agents.list()` **涵盖子 agent**（subagent 子会话、Agent Teams teammate）。
  4. **EXIT → POST**：写恢复标记 → 重启；重启后恢复未完成会话与渐进回调会话。
- **方案 B：回执式恢复** —— `dsh_restart_register_callback` 让任何会话注册“重启后继续该任务”的回调；重启后先等 `bootRestoreDelayMs`（1 分钟），然后**每 `restoreStaggerMs`（5 秒）唤醒一个**回调会话。被恢复的会话须用 `dsh_restart_callback_done` 回执；超时 `callbackUnackTimeoutMs`（30 分钟）未回执先提醒一次，再记 `callback-unacked`。
- **AI 工具** —— `dsh_restart` / `dsh_restart_cancel` / `dsh_restart_register_callback` / `dsh_restart_callback_done`。严格校验，越界**绝不静默钳制**。
- **调度引擎** —— 250ms 心跳的**分钟边界检测**（抗事件循环抖动），每分钟对全部注册回调求值一次。
- **自愈重启（双保险）** —— EXIT 前总是先挂一个 detached **自愈 helper**，再退出旧进程：
  1. 最多等 60s 让端口释放；
  2. 端口已被**健康的 dsh** 接管（如 systemd 已拉起新实例）→ 让位；若只是非 dsh 进程占着 → 继续尝试；
  3. 否则用原 argv 重新拉起 + **健康探测**（30s）+ **最多 3 次重试**，逐步写入日志；
  4. supervisor 模式（systemd `Restart=on-failure` / 容器）照常工作：supervisor 抢先时 helper 让位。
- **演练模式** —— 配置 `simulateOnly: true` 或环境变量 `DSH_RESTART_SIMULATE=1`：finalize 记 `restart-simulated` 并**在同一进程内**跑完恢复流程、不退出。`/status` 暴露 `simulate: true`。
- **0.2.0 原生接入** —— 通过 `agent/created` 事件（含 `SessionStartSource`）**事件驱动恢复**而非盲等 1 分钟；监听 `app-boot/config-reload` 并以 `lastConfigReloadAt` 呈现；旧版平铺键自动翻译。
- **WebUI 设置页** —— 「DSH 重启」卡片（权限 / PRE / POST / 调度 / 回调 / 日志）乐观更新；右下角非阻塞小窗提示等待中的重启（默认前缀 `【DSH 重启】`）。

---

## 前置条件

插件**运行在 dsh 内部**（是 Cordis 宿主插件），所以以下都以"已装好 dsh"为起点——**无需自己安装 Node**：

- 一个可用且已启动的 **dsh ≥ 0.1.5**（推荐 0.2.x；本插件已在 0.2.0-rc.2 全量测试）。dsh 自带 Node 运行时，Web UI 在其配置端口可访问（默认 `3080`）。
- 能写入该实例的 **profile**（`node_modules` 与组合补丁 `cordis.patch.yml`）——通常在 `$DSH_HOME/profiles/<名称>/`。
- **dsh web 端口没有被别的进程抢占**（若有第二个实例占着端口，重启 helper 会"让位"而不是拉起新进程）。
- **裸跑（无 supervisor）建议挂外部守护**：只有*请求式*重启会通过 detached helper 自愈；意外被杀（helper 未武装时）没有重启者。优先用 `systemd` 的 `Restart=on-failure` 或容器重启策略（插件会以退出码 125 触发）。

---

## 安装

### 方式 A —— 从 npm（发布后）

```bash
cd "$DSH_HOME/profiles/<你的-profile>"      # 例如 ~/.dsh/profiles/web
pnpm add dsh-harness-restart                 # 或：npm install dsh-harness-restart
```

### 方式 B —— 离线 / tarball

```bash
cd "$DSH_HOME/profiles/<你的-profile>"
pnpm add ./dsh-harness-restart-0.1.0.tgz
# 或直接把包目录放到：
#   node_modules/dsh-harness-restart/
```

### 启用插件行

在 profile 组合补丁（`profiles/<名称>/cordis.patch.yml`）里插入一行：

```yaml
- insert:
    - id: harness-restart
      name: 'dsh-harness-restart'
      config: {}          # 全部用默认值；完整参数见下表
```

然后**重启 dsh**，打开 设置 → **「DSH 重启」**。可用以下命令确认装载成功：

```bash
dsh --profile <你的-profile> --dump-config | grep -A3 harness-restart
```

peer 依赖（dsh ≥ 0.1.5 / 0.2.0 均满足，无需额外安装）：

```
@deepseek-ai/cordis    ^4.0.2
@deepseek-ai/dsh-tools >=0.0.1-rc.1
@deepseek-ai/dsh-llm   >=0.0.1-rc.1
@deepseek-ai/schemastery ^3.18.0
react                  ^18.2.0
```

---

## 配置

所有键均可选。优先级：**运行时覆盖文件**（`$DSH_HOME/dsh-harness-restart-v1.json`）> **组合配置**（`cordis.patch.yml` 行）> **默认值**。越界值**直接报错**（绝不钳制）；损坏的覆盖文件回退默认并给出可见 `warnings`，不会让启动失败。

| 键 | 默认 | 含义 |
|---|---|---|
| `ai.restartEnabled` | `true` | 是否允许 AI 发起重启 |
| `ai.challengeEnabled` | `true` | AI 发起需两段式挑战 |
| `ai.allowNow` | `false` | 是否允许 AI 用 `now` |
| `ai.delayRangeMs` | `[180000, 3600000]` | AI 的 `delay` 区间（3 分钟~1 小时）；越界 → 报错并给推荐值（`ai.recommendDelayMs`，5 分钟） |
| `trigger.defaultTrigger` / `defaultDelayMs` | `delay` / `300000` | 调度命中后的默认触发方式 |
| `schedule` | `[]` | `{id, kind: preset\|script, preset?, args?, script?, enabled?}` —— 预设 `now/delay/daily/weekly/immediate/waitSeconds/waitAllOrForce`；脚本按完全信任执行（强告警 + 审计 sha256） |
| `preRestart` | `{mode:'waitAllOrForce', forceAfterMs:30000}` | `immediate` / `waitSeconds(N)` / `waitAllOrForce(-1=无限等)` |
| `postRestart` | `{mode:'resumeAll'}` | `none` / `resumeRequester` / `resumeAll` |
| `restartDelayMs` | `2000` | 旧进程退出前缓冲（ms） |
| `challengeTtlMs` | `300000` | 挑战 token 有效期 |
| `bootRestoreDelayMs` | `60000` | 渐进恢复首个等待 |
| `restoreStaggerMs` | `5000` | 之后每 N ms 唤醒一个回调会话 |
| `callbackUnackTimeoutMs` | `1800000` | 回执超时（30 分钟）→ 提醒一次 |
| `simulateOnly` | `false` | 演练模式：不真重启（或环境变量 `DSH_RESTART_SIMULATE=1`） |
| `notifyPrompt` / `continuePrompt` / `restorePrompt` | `【DSH 重启】…` | 提示文案；占位符 `{minutes}` / `{cbId}` / `{description}` |
| `logTailLines` | `300` | 日志查看器尾部行数 |

旧版 v0.1.x 平铺键（`aiRestartEnabled`、`restartPolicy`、`notifyWaitMs` 等）自动兼容翻译。

---

## HTTP API

所有路由位于 `/plugins/dsh-harness-restart` 之下，**仅限本机/私有网段 + 同源**访问。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/status` | pid、模式、配置、pending、回调、supervisors、`simulate`、`lastConfigReloadAt` |
| GET | `/config` | 生效配置 + warnings |
| POST | `/config` | 写配置（`{patch: {...}}`），严格校验 |
| POST | `/restart` | `{trigger:'now'|'delay', delayMs?}` → 202 waiting / 200 accepted / 409 单飞行 |
| POST | `/cancel` | 取消等待中的重启 |
| GET | `/check` | 只读预检 |
| GET | `/log` | 事件日志尾部 |
| GET | `/log/open` | 事件日志路径 |

事件日志：`$DSH_HOME/dsh-harness-restart.log` —— 记录 `restart-waiting` / `restart-about-to-exit` / `restart-finalized` / `restart-simulated` / `restart-resumed` / `restore-step` / `callback-error` / `schedule-trigger` / `ai-restart-denied` 等，一行一个 JSON。

---

## 边界与限制

- **只作用于 dsh 进程本身。** 插件只重启它所在的 dsh web 进程，不重启、不触碰、不管理任何其它系统进程或服务。
- **无 supervisor 时崩溃不自愈。** 裸跑下 detached helper 只在*请求式*重启（`/restart`、工具、调度）时才挂载；如果 dsh 在 helper 就绪前意外被杀（OOM、`kill -9`、断电），没有东西会拉起它——崩溃韧性请交给 systemd / 容器。
- **重启后继续依赖 dsh 自身的会话持久化。** 插件负责注入"继续"提示（恢复目标 + 已注册回调）；会话历史能保留是因为 dsh 持久化了会话日志。无法复活的会话（无 live agent、无 `sessionController`）会被跳过并记录。
- **只恢复"未完成 + 已注册回调"的会话。** `resumeAll` 覆盖未完成根会话与子 agent（经 `agents.list()`）；其它归档/已关闭会话不干预。
- **同一时刻只允许一个 pending 重启（单飞行）。** 并发第二个请求返回 `409`，直到第一个被取消或完成。
- **AI 限制是有意的。** AI 默认不能用 `now`，`delay` 必须落在 `ai.delayRangeMs` 区间内，每次重启都要过两段式挑战。
- **公开/隧道化部署会失去探针路由。** 域名 Host 一律 `403`；页面自动重开与日志打开退化为打印出的 token URL。
- **演练模式不会产生真实重启。** `simulateOnly` 在进程内跑完整事件链与恢复流程，什么也不会退出，`/status` 不会出现新 pid。
- **helper 日志在 `/tmp`**（`/tmp/dsh-harness-restart-<stamp>-<port>.{out,err}.log`），可能被系统在重启时清理；权威事件轨迹是 `$DSH_HOME/dsh-harness-restart.log`。

---

## 安全

完整威胁模型见 [`SECURITY.md`](SECURITY.md)。要点：

- **路由守卫**：所有读写路由只接受回环 / 私有 IP 字面量作为 `Host`，且带 `Origin` 时必须同源；**域名 Host（含 DNS 重绑定候选）一律 `403`**，绝不降级。
- **AI 工具**：两段式挑战（16 位 hex token、一次性、5 分钟 TTL）绑定首次调用的参数；AI 关 `now`；越界 `delay` 拒绝并给推荐值。
- **配置写入**：按键严格校验（`validateConfigV1`）；越界值拒绝、绝不钳制；只能写插件自己的配置命名空间。
- **脚本回调以完全信任执行**（宿主进程内 `new Function`）；永不远端拉取、注册带强告警、事件日志带审计 sha256、单个可禁用（`enabled: false`）。
- **写入的数据**：`$DSH_HOME/dsh-resume.json`（会话 id、发起者、已注册回调、时间戳）与 `$DSH_HOME/dsh-harness-restart.log`（事件；可能含会话 id 与本地路径）——都只属 harness 用户。

---

## 测试（安全，不碰运行中的 dsh）

这个插件会重启自身进程——直接在线上测正是我们设计掉的事。

```bash
npm run test          # 纯逻辑 + 客户端契约（72+11+11 断言，毫秒级）
npm run test:simulate # 隔离实例演练：完整事件链、零进程死亡（11 项）
npm run test:e2e      # 隔离实例含一次真实重启闭环（10 项）
npm run test:chaos    # 9 个故障注入场景（kill -9 / 端口被非 dsh 抢占 / 并发 409 /
                      # 删 helper 文件 / 损坏 marker / 损坏配置 / 演练等）
```

每个隔离场景使用 `/tmp` 下的临时 `DSH_HOME`、独立端口，`trap` 必定清理。真实重启闭环只发生在这些**替身实例**上，绝不会动你在用的 dsh。

---

## License

MIT —— 见 [`LICENSE`](LICENSE)。

## 安全

见 [`SECURITY.md`](SECURITY.md)。