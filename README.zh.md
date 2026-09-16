# dsh-harness-restart

从**设置页**重启整个 DeepSeek Harness 进程（不放侧栏按钮，避免误触）：重启按钮、三种重启策略、AI 重启权限开关 + **两段式挑战认证**、模型工具 `dsh_restart` / `dsh_restart_cancel`、`/restart` 命令、内置**日志查看器**（可一键打开源文件）；重启机制环境自适应；重启后**自动继续未完成会话**；页面**自动用新凭证重开**。

## 功能

- 设置 →「**DSH 重启**」整页（自上而下：权限 → 重启+策略 → 日志），全部使用 `--dsw-alias-*` 主题 token（深浅两套自适应）。
  - 「按当前策略重启」+「取消等待中的重启」；
  - 三种**重启策略**，右下角**非阻塞小窗**实时显示**发起方**与**剩余倒计时**；
  - 「允许 AI 使用重启功能」「AI 发起重启需要二次认证」开关（服务端强制执行）；
  - **日志**卡：实时尾部、自动刷新、一键打开源文件。
- **模型工具 `dsh_restart`** —— AI **两段式认证**：首次调用返回 16 位认证串 + 引导；二次调用必须原样携带**同一认证串且 `policy` 与首次完全一致**才真正重启。AI 不能用 `now`；等待策略**硬性 ≥3 分钟**倒计时，并弹窗让用户可取消。
- **`dsh_restart_cancel`** —— 仅取消「由 AI 发起且仍在等待」的重启。
- **重启后自动继续** —— 重启前把「进行中 turn ∪ 有活动 goal 的根会话」写入 `$DSH_HOME/dsh-resume.json`，新进程启动后逐个注入继续提示（agent live 用 followup，冷会话用 `sessionController.prompt` 兜底），完成后清标记。
- **凭证轮换自愈** —— dsh 每次启动轮换 launch token；探针路由下发新进程 `authenticatedUrl()`，页面自动用新凭证重开（页面在场时，按钮与 AI 发起的重启都适用）。

## 重启策略

| 策略 | 行为 |
|---|---|
| `now` | 立即重启（留出退出回传时间）。**仅页面 / `/restart`；AI 禁用**。 |
| `wait-idle` | 等全部根会话回合结束/阻塞后重启；超时（默认 10 分钟，下限 3 分钟）取消。AI 发起时即便已空闲也至少等 3 分钟。 |
| `notify` | 先向所有活跃会话注入提示词（默认「DSH 将在约 N 分钟后重启…」，`{minutes}` 占位可编辑），等 `notifyWaitMs`（默认 5 分钟，下限 3 分钟）后重启；期间全部空闲可提前（AI 发起仍至少 3 分钟）。 |

等待类策略都有实时进度与**取消**入口。

## 重启机制（环境自适应，零外部命令）

| 运行形态 | 检测方式 | 重启路线 |
|---|---|---|
| systemd 单元 | `INVOCATION_ID` **且** 自身 cgroup 在 `/system.slice/` | 写恢复标记 → `exit(125)` → systemd `Restart=on-failure` 原样拉起 |
| 容器（有 restart 策略） | `/proc/1` cgroup/comm | 同上，交给容器 restart 策略 |
| 裸跑（终端 / npx / 无监管者） | 无监管者标记 | detach helper 等旧进程退出并释放端口后，按原 argv + cwd 重新拉起（Windows 隐藏控制台） |

不需要 sudo、不需要 bash 脚本、不需要独立 watchdog；«启动失败»由监管者自身的失败重启策略兜底（systemd 默认 5 次/10 秒）。

## 凭证轮换恢复（最容易做错的一环）

dsh 每次启动轮换 launch token，旧页面无法自行恢复。插件使用核心的两个官方接口：`ctx.connection.requestRejection()`（给其它 Web 路由套 Host/Origin 检查与浏览器鉴权）与 `ctx.connection.authenticatedUrl()`（新 token URL）。客户端轮询**仅本机可读**的探针路由，身份变化时跳转到新 URL —— 服务端换新 cookie 并 303 回干净的 `/`。

## 安全边界

- 核心 **403 绝不降级**；只有 **401（凭证轮换）** 允许降级到「本机/私有网段 IP 字面量 + 同源」（域名/DNS rebinding 一律拒绝）。
- **变更类路由**（重启/改配置/取消/打开日志）要求核心完整鉴权（`requestRejection` 必须放行）；连接服务不可用时退回「本机 socket + 同源」。
- 探针/日志路由为恢复需要可无凭证读取，但只限本机/私有网段 authority。
- `POST /config` 逐键严格校验：**越界直接报错、绝不静默钳制**（`restartDelayMs 0–60000ms`；`waitIdleTimeoutMs`/`notifyWaitMs` `180000–86400000ms`；布尔严格；文本非空 ≤2000 字符）。
- AI 重启：两段式挑战（16 位、一次性、5 分钟过期）**绑定首次调用的 `policy`** + 硬性 3 分钟倒计时 + 用户可见弹窗。

## 局限性（使用前请读）

1. **AI 不能立即重启**（`now` 仅页面可用）——有意保护会话。
2. systemd 自动恢复要求监管者配置了 `Restart=on-failure`（或容器 restart 策略）。**裸跑（无监管者）时插件不提供崩溃守护**：按请求能自重启（helper），但进程异常崩溃无人拉起——请挂在监管者或重试循环下运行。
3. 只有重启时**有页面在场**才会自动重开（轮询跑在浏览器里）；无页面在场则需手动打开新地址。
4. 重启会**打断所有会话与连接**；正在流式输出的 assistant 消息可能丢失末尾几个字（turn 标记 `interrupted`）——历史不会损坏。
5. 仅「排队中、尚未落盘」的消息会随任何重启丢失——这是 dsh 核心行为，插件不改变。
6. 恢复标记只覆盖「进行中 turn 或活动 goal 的根会话」；其余会话不打扰（UI 照常重新打开）。
7. 探针/日志路由**有意拒绝域名访问**（仅本机/私有网段 IP 字面量）——远程隧道等场景无法自动恢复/一键打开日志（从日志里手动复制 URL）。
8. **仅 web 平台**（TUI/desktop 不做）；假设单实例——两个实例共享同一 `$DSH_HOME` 会共用恢复标记/日志。
9. 认证串是内存态：插件热重载或手动重启后失效，重新调用工具再发一次即可。
10. 不提供清空会话等破坏性操作（有意不作）。

## 依赖

- **运行时**：Node >= 20；`dsh >= 0.1.5-rc.1`（已实测基线）且运行 **web** profile（`dsh web`）。
- **import 的包**（全部为**可选 peerDependencies**，解析到 DSH 运行时的单一副本，绝不引入第二份——见 [#1337](https://github.com/deepseek-ai/deepseek-harness/discussions/1337)）：`@deepseek-ai/dsh-tools`（`defineTool`）、`@deepseek-ai/dsh-llm`（`createUserMessage`）、`@deepseek-ai/schemastery`（配置 schema）。
- **通过 `ctx` 探测使用的服务**（缺失各自降级）：`tools`、`agents`、`webServer`、`commands`、`settings`、`sessionController`、`goals`、`connection`。
- **运行期写入文件**（`$DSH_HOME` 下）：`dsh-resume.json`（恢复标记）、`dsh-harness-restart.log`（事件与排障）。
- **无 sudo / 无 bash 脚本 / 无 watchdog / 无 npm 运行时依赖。**

## 安装

### 一行命令（推荐，发布后）

```sh
# GitHub 方式
dsh plugin --profile web add github:<owner>/dsh-harness-restart

# 或 npm 方式（发布后）
dsh plugin --profile web add dsh-harness-restart
```

装完**重启一次 DSH** 生效（之后的每次重启由插件自己管理）。

### 给 AI 的安装流程（可直接交给你的 agent）

1. 执行：`dsh plugin --profile web add github:<owner>/dsh-harness-restart`（或 npm 版）。
2. 若网络拉不动 pnpm，回退到手工编辑 `profiles/<profile>/package.json`：`dependencies` 加 `"dsh-harness-restart": "file:/path/to/dsh-harness-restart"`，`dsh.profile.bundles` 加 `"dsh-harness-restart"`，然后在该目录执行 `pnpm install`。
3. 验证组合：`dsh --profile web --dump-config | grep -c harness-restart` 应 ≥ 1。
4. 重启一次 DSH（如 `sudo systemctl restart dsh-web.service`，或手动终端里重启 `dsh web`）。
5. 验证：设置 →「DSH 重启」出现；AI 随后可用 `dsh_restart`（`policy: wait-idle|notify`）+ 按引导携带认证串，小窗显示「发起方：AI（模型工具）」与倒计时。

### 人类手动安装

1. 安装 dsh：`npm i -g @deepseek-ai/dsh`（Node >= 20）。
2. 选定来源：GitHub tag / npm / 本地 checkout（见一行命令）。
3. 在 `profiles/<profile>/package.json` 加依赖与 bundle 项（`file:` 写法见 AI 流程；npm/GitHub 用 `dsh plugin … add` 自动完成）。
4. `cd ~/.dsh/profiles/<profile> && pnpm install`（或走 `dsh plugin`）。
5. 重启一次 DSH。

## 兼容性

- 已在 `dsh 0.1.5-rc.1` 上验证；声明为 `dsh.engines.dsh >= 0.1.5-rc.1`。0.1.x API 可能漂移——升级 dsh 前看 CHANGELOG 的兼容矩阵。
- 测试：`npm test`（单元，85 断言）+ `npm run test:profile`（隔离环境真实安装冒烟）——都不碰正在运行的实例。

## 致谢

- 重启机制、身份探针与自动继续参考 [anweat/dsh-restart](https://github.com/anweat/dsh-restart)（MIT）；detach relaunch helper 改编自其 `relaunch-helper`——见 [NOTICE](./NOTICE)。
- 设置页入口的落点想法受 [1123762794/dsh-web-restart](https://github.com/1123762794/dsh-web-restart) 启发。

## License

MIT —— 见 [LICENSE](./LICENSE)。