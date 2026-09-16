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

### 修复
- 自（bare-run）模式旧进程未按时退出导致 helper 抢占端口失败（隔离实例实测发现）
- 设置页策略单选「点了无法选中」（配置回读时序 → 服务端合并回显 + 客户端乐观选中）
- client 半必须用 `window.__ModuleLoader__.load` 注册（早期 `module.exports` 无效）
- supervisor 检测误判（用户级 scope 的 `INVOCATION_ID` 不应视为 systemd 单元）

### 兼容
- 已实测基线：`dsh 0.1.5-rc.1`（声明 `dsh.engines.dsh >= 0.1.5-rc.1`）
- 依赖全部可选 peer，运行时单副本解析（见 README「依赖」）

[0.1.0]: https://github.com/<owner>/dsh-harness-restart/releases/tag/v0.1.0