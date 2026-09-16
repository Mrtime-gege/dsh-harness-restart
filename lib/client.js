/**
 * dsh-harness-restart —— 客户端侧（browser half）
 *
 * 注册（加法，随插件卸载自动释放）：
 *   * `settings.section`：设置 →「DSH 重启」整页。栏位顺序（自上而下）：
 *       1. 权限（允许 AI 重启 / 二次认证开关）
 *       2. 日志（尾部实时展示 + 一键打开源文件）
 *       3. 重启 DeepSeek Harness（按钮/实时状态/策略/注入提示词，置底）
 *   * `shell.overlay`：重启进度遮罩（等待策略倒计时 / 重启中 / 自动重开）。
 *
 * 重启按钮放在设置页而不是侧栏：侧栏图标容易误触，而重启会打断所有会话。
 *
 * 数据走同源 HTTP 直连宿主：
 *   GET  /plugins/dsh-harness-restart/status   身份 + 策略状态 + 空闲快照 + 新凭证 url
 *   GET  /plugins/dsh-harness-restart/config   当前配置
 *   POST /plugins/dsh-harness-restart/config   写配置（settings.yaml）
 *   POST /plugins/dsh-harness-restart/restart  按策略重启
 *   POST /plugins/dsh-harness-restart/cancel   取消等待中的重启
 *   GET  /plugins/dsh-harness-restart/log      日志尾部
 *   POST /plugins/dsh-harness-restart/log/open 打开日志源文件（桌面文件管理器）
 *
 * 凭证轮换自愈：dsh 每次启动轮换 launch token，宿主在 /status 下发新进程
 * authenticatedUrl()，页面 navigate 过去即可换到新 cookie（无需手动操作）。
 *
 * 客户端硬契约：必须用 `window.__ModuleLoader__.load({ id, factory })` 注册。
 */

window.__ModuleLoader__.load({
  id: "dsh-harness-restart",
  factory: (require) => {
    const react = require("react");
    const h = react.createElement;

    const inject = ["slots"];
    const name = "dsh-harness-restart";
    const BASE = "/plugins/dsh-harness-restart";
    const CSS_ID = "dshhr-styles";

    /* ── 样式（只使用 DSH 主题 --dsw-alias-* token）─────────────────────── */
    const CSS = `
.dshhr-section { display: flex; flex-direction: column; gap: 14px; max-width: 760px; padding: 2px 2px 28px; }
.dshhr-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px 18px; }
.dshhr-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); margin-bottom: 4px; }
.dshhr-desc { font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.dshhr-body { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.dshhr-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.dshhr-row-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshhr-row-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; line-height: 1.5; }
.dshhr-radio { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; cursor: pointer; background: transparent; text-align: left; }
.dshhr-radio:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.dshhr-radio.is-active { border-color: var(--dsw-alias-brand-primary); }
.dshhr-radio-dot { flex: none; width: 14px; height: 14px; margin-top: 2px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l2); }
.dshhr-radio.is-active .dshhr-radio-dot { border-color: var(--dsw-alias-brand-primary); border-width: 4px; }
.dshhr-radio-name { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshhr-radio-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; line-height: 1.5; }
.dshhr-input { font: inherit; font-size: 13px; width: 82px; padding: 5px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshhr-textarea { font: inherit; font-size: 12.5px; width: 100%; min-height: 56px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); resize: vertical; line-height: 1.6; box-sizing: border-box; }
.dshhr-switch { position: relative; flex: none; width: 38px; height: 22px; padding: 0; border: none; border-radius: 11px; background: var(--dsw-alias-border-l2); cursor: pointer; transition: background .15s ease; }
.dshhr-switch.is-on { background: var(--dsw-alias-brand-primary); }
.dshhr-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s ease; }
.dshhr-switch.is-on::after { transform: translateX(16px); }
.dshhr-switch:disabled { opacity: .5; cursor: not-allowed; }
.dshhr-btn { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dshhr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.dshhr-btn:disabled { opacity: .45; cursor: not-allowed; }
.dshhr-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.dshhr-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.dshhr-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dshhr-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshhr-badge { font-size: 12px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.dshhr-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.dshhr-badge-warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dshhr-badge-err { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dshhr-fine { font-size: 11.5px; color: var(--dsw-alias-label-secondary); opacity: .9; line-height: 1.5; }
.dshhr-log { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.55; max-height: 240px; overflow: auto; margin: 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: pre; }
.dshhr-log-event { color: var(--dsw-alias-label-primary); }
.dshhr-log-path { user-select: all; word-break: break-all; }
.dshhr-pop { position: fixed; right: 18px; bottom: 18px; z-index: 9998; width: 320px; padding: 14px 16px; border-radius: 12px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 6px 24px rgba(0,0,0,.35); color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 1.6; display: flex; flex-direction: column; gap: 8px; }
.dshhr-pop-title { font-size: 13px; font-weight: 600; }
`;

    /* ── 跨组件状态（设置页与遮罩共享）────────────────────────────────── */
    const listeners = new Set();
    let ui = { phase: "idle", message: "", policy: null, deadline: 0, notice: false, source: null };
    function setUi(next) {
      ui = { ...ui, ...next };
      for (const listener of [...listeners]) listener(ui);
    }
    function subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
    function useUi() {
      try { return react.useSyncExternalStore(subscribe, () => ui); } catch { return ui; }
    }

    function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

    /* ── 宿主 API ─────────────────────────────────────────────────────── */
    async function api(path, init) {
      const response = await fetch(`${BASE}${path}`, {
        cache: "no-store",
        headers: init && init.body ? { "content-type": "application/json" } : undefined,
        ...init,
      });
      if (response.status === 401 || response.status === 403) {
        const denied = new Error("AUTH");
        denied.denied = true;
        throw denied;
      }
      const data = await response.json().catch(() => null);
      return data;
    }
    const getStatus = () => api("/status");
    const getConfig = () => api("/config");
    const saveConfig = (patch) => api("/config", { method: "POST", body: JSON.stringify({ patch }) });
    const postRestart = (policy, dryRun) =>
      api("/restart", { method: "POST", body: JSON.stringify({ policy: policy || undefined, dryRun: dryRun === true }) });
    const postCancel = () => api("/cancel", { method: "POST", body: "{}" });
    const getLog = (lines) => api(`/log?lines=${lines || 300}`);
    const openLog = () => api("/log/open", { method: "POST", body: "{}" });

    const POLICY_LABEL = { now: "立即重启", "wait-idle": "等待全部会话空闲", notify: "通知后等待重启" };
    const SOURCE_LABEL = { button: "设置页按钮", tool: "AI（模型工具）", command: "/restart 命令" };
    function minutes(ms) { return Math.max(1, Math.round(ms / 60000)); }
    function fmtRemaining(ms) {
      const seconds = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
    }
    function useClock(active) {
      const [now, setNow] = react.useState(Date.now());
      react.useEffect(() => {
        if (!active) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [active]);
      return now;
    }

    /* ── 数据 hooks ───────────────────────────────────────────────────── */
    function useStatus(active) {
      const [status, setStatus] = react.useState(null);
      const [error, setError] = react.useState("");
      react.useEffect(() => {
        let alive = true;
        const tick = async () => {
          if (!alive) return;
          try {
            const value = await getStatus();
            if (alive) { setStatus(value); setError(""); }
          } catch (err) {
            if (alive) setError(err && err.denied ? "当前访问来源不被信任" : "无法读取宿主状态");
          }
        };
        void tick();
        if (!active) return () => { alive = false; };
        const timer = setInterval(() => { void tick(); }, 2000);
        return () => { alive = false; clearInterval(timer); };
      }, [active]);
      return [status, error];
    }

    function useConfig() {
      const [config, setConfig] = react.useState(null);
      const [note, setNote] = react.useState("");
      react.useEffect(() => {
        let alive = true;
        void getConfig()
          .then((value) => { if (alive && value && value.ok) setConfig(value.config); })
          .catch(() => { if (alive) setNote("配置读取失败"); });
        return () => { alive = false; };
      }, []);
      const save = react.useCallback(async (patch) => {
        try {
          const value = await saveConfig(patch);
          if (value && value.ok && value.config) {
            setConfig(value.config);
            setNote("已保存");
            setTimeout(() => setNote(""), 2500);
            return true;
          }
          // 服务端严格校验失败：原样保留旧值，直接显示错误信息（不钳制、不乐观合并）
          setNote((value && value.error) || "保存失败");
        } catch (err) {
          setNote(err && err.denied ? "保存失败：鉴权被拒绝" : "保存失败");
        }
        setTimeout(() => setNote(""), 3500);
        return false;
      }, []);
      return [config, save, note];
    }

    /* ── 重启流程（含凭证交接与弹窗自愈）─────────────────────────────── */
    async function runRestart(policy) {
      if (ui.phase !== "idle") return;
      setUi({ phase: "restarting", message: "", policy: policy || null, deadline: 0, notice: false, source: "button" });
      let baseline = null;
      try {
        baseline = await getStatus();
      } catch (err) {
        setUi({ phase: "error", message: err && err.denied ? "当前访问来源不被信任，无法重启。" : "无法读取宿主状态，已取消。" });
        return;
      }
      let result = null;
      try {
        result = await postRestart(policy);
      } catch (err) {
        setUi({ phase: "error", message: err && err.denied ? "重启请求被拒绝（来源不可信或凭证无效）。" : "重启请求失败。" });
        return;
      }
      if (!result || result.ok !== true) {
        setUi({ phase: "error", message: (result && result.error) || "重启请求失败。" });
        return;
      }
      setUi(result.phase === "waiting"
        ? { phase: "waiting", policy: result.policy, deadline: Number(result.deadline) || Date.now() + (result.etaMs || 0), source: result.source || "button", message: "" }
        : { phase: "restarting", message: "" });

      for (let i = 0; i < 150; i += 1) {
        await sleep(1000);
        let current = null;
        try { current = await getStatus(); } catch { /* 旧进程已退，继续等 */ }
        if (current === null) continue;

        if (current.pid !== baseline.pid || current.startedAt !== baseline.startedAt) {
          // 新进程已就绪：用宿主下发的新凭证地址自动重开。
          setUi({ phase: "handoff", message: "" });
          const target = typeof current.url === "string" && current.url !== "" ? current.url : null;
          // 保险：若跳转未能发生（url 缺失且回退被拦截等），6 秒后回落干净根路径。
          window.setTimeout(() => { window.location.replace("/"); }, 6000);
          if (target !== null) { window.location.replace(target); return; }
          // 连接服务可能仍在装载使 url 暂缺：最多再等 8 秒。
          for (let k = 0; k < 8; k += 1) {
            await sleep(1000);
            try {
              const next = await getStatus();
              if (next !== null && typeof next.url === "string" && next.url !== "") {
                window.location.replace(next.url);
                return;
              }
            } catch { /* ignore */ }
          }
          window.location.replace("/");
          return;
        }

        if (current.pending && current.pending.phase === "waiting") {
          const pendingUi = { phase: "waiting", policy: current.pending.policy, deadline: current.pending.deadline, message: "" };
          if (current.pending.source) pendingUi.source = current.pending.source;
          setUi(pendingUi);
          continue;
        }
        if (ui.phase === "waiting" && current.pending === null) {
          const reason = (current.lastOutcome && current.lastOutcome.reason) || "等待已结束";
          setUi({ phase: "stalled", message: `${reason}；进程未重启。` });
          return;
        }
      }
      setUi({ phase: "stalled", message: "等待超时：进程没有按预期重启（检查服务与监管者配置）。" });
    }

    async function cancelPending() {
      try {
        const result = await postCancel();
        setUi({ phase: "idle", message: "" });
        if (!result || result.ok !== true) setUi({ phase: "error", message: (result && result.error) || "取消失败" });
      } catch {
        setUi({ phase: "idle", message: "" });
      }
    }

    /* ── 小组件 ───────────────────────────────────────────────────────── */
    function Switch(props) {
      return h("button", {
        type: "button",
        className: `dshhr-switch${props.on ? " is-on" : ""}`,
        role: "switch",
        "aria-checked": props.on ? "true" : "false",
        "aria-label": props.label,
        disabled: props.disabled === true,
        onClick: () => props.onChange(!props.on),
      });
    }

    function PolicyOption(props) {
      return h("button", {
        type: "button",
        className: `dshhr-radio${props.active ? " is-active" : ""}`,
        onClick: () => props.onSelect(props.value),
      },
        h("span", { className: "dshhr-radio-dot" }),
        h("span", null,
          h("div", { className: "dshhr-radio-name" }, props.title),
          h("div", { className: "dshhr-radio-desc" }, props.desc),
        ),
      );
    }

    /* ── 设置页：权限（置顶）──────────────────────────────────────────── */
    function PermissionCard({ config, save }) {
      const aiOn = !(config && config.aiRestartEnabled === false);
      const challengeOn = (config && config.aiRestartChallenge) !== false;
      return h("div", { className: "dshhr-card" },
        h("div", { className: "dshhr-title" }, "权限"),
        h("div", { className: "dshhr-desc" },
          "重启会中断所有会话，因此 AI 侧默认需要一次二次认证；也可以彻底关闭 AI 的重启能力。"),
        h("div", { className: "dshhr-body" },
          h("div", { className: "dshhr-row" },
            h("div", null,
              h("div", { className: "dshhr-row-label" }, "允许 AI 使用重启功能"),
              h("div", { className: "dshhr-row-hint" }, "关闭后模型工具 dsh_restart 一律被拒绝（页面按钮不受影响）。"),
            ),
            h(Switch, { label: "允许 AI 使用重启功能", on: aiOn, onChange: (value) => { void save({ aiRestartEnabled: value }); } }),
          ),
          h("div", { className: "dshhr-row" },
            h("div", null,
              h("div", { className: "dshhr-row-label" }, "AI 发起重启需要二次认证"),
              h("div", { className: "dshhr-row-hint" }, "首次调用只返回 16 位随机认证串与引导；二次调用携带并匹配该串后才真正重启。"),
            ),
            h(Switch, {
              label: "AI 发起重启需要二次认证",
              on: challengeOn,
              disabled: !aiOn,
              onChange: (value) => { void save({ aiRestartChallenge: value }); },
            }),
          ),
        ),
      );
    }

    /* ── 设置页：日志 ─────────────────────────────────────────────────── */
    function LogCard() {
      const [lines, setLines] = react.useState([]);
      const [path, setPath] = react.useState("");
      const [auto, setAuto] = react.useState(true);
      const [note, setNote] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const tick = react.useCallback(async () => {
        try {
          const value = await getLog(300);
          setLines(value && Array.isArray(value.lines) ? value.lines : []);
          if (value && value.path) setPath(value.path);
        } catch { /* ignore */ }
      }, []);
      react.useEffect(() => {
        void tick();
        if (!auto) return undefined;
        const timer = setInterval(() => { void tick(); }, 3000);
        return () => clearInterval(timer);
      }, [auto, tick]);
      const open = react.useCallback(async () => {
        setBusy(true);
        try {
          const value = await openLog();
          if (value && value.opened === true) setNote("已在文件管理器中打开日志文件");
          else if (value && value.path) setNote(`无法自动打开：${value.error || "当前部署不支持"}；请手动打开右侧路径`);
          else setNote("打开失败");
        } catch {
          setNote("打开失败");
        }
        setBusy(false);
        setTimeout(() => setNote(""), 5000);
      }, []);
      return h("div", { className: "dshhr-card" },
        h("div", { className: "dshhr-title" }, "日志"),
        h("div", { className: "dshhr-desc" },
          "记录 AI 发起的重启请求、二次认证、被拒绝的重启、策略等待与取消等事件；也含技术排障行。"),
        h("div", { className: "dshhr-body" },
          h("div", { className: "dshhr-actions" },
            h("button", { type: "button", className: "dshhr-btn", onClick: () => { void tick(); } }, "刷新"),
            h("button", { type: "button", className: "dshhr-btn", disabled: busy, onClick: () => { void open(); } }, "打开日志文件"),
            h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
              h("span", null, "自动刷新"),
              h(Switch, { label: "日志自动刷新", on: auto, onChange: setAuto }),
            ),
            note ? h("span", { className: "dshhr-fine" }, note) : null,
          ),
          h("pre", { className: "dshhr-log" },
            lines.length === 0
              ? "（暂无日志）"
              : lines.map((line, index) =>
                h("div", { key: index, className: /^EVENT /.test(line) ? "dshhr-log-event" : undefined }, line)),
          ),
          path ? h("div", { className: "dshhr-fine" }, h("span", { className: "dshhr-log-path" }, path)) : null,
        ),
      );
    }

    /* ── 设置页：重启（置底，与策略合并）─────────────────────────────── */
    function RestartCard({ status, config, save, note }) {
      const state = useUi();
      const busy = state.phase !== "idle";
      const [draftPolicy, setDraftPolicy] = react.useState(null);
      const policy = draftPolicy || (config && config.restartPolicy) || (status && status.policy) || "now";
      const pending = status && status.pending ? status.pending : null;
      const idleness = status && status.idleness ? status.idleness : { total: 0, running: 0, idle: 0 };
      const selectPolicy = react.useCallback((value) => {
        setDraftPolicy(value); // 立即选中，不依赖服务端回读
        void save({ restartPolicy: value }).then((ok) => { if (ok !== true) setDraftPolicy(null); });
      }, [save]);

      return h("div", { className: "dshhr-card" },
        h("div", { className: "dshhr-title" }, "重启 DeepSeek Harness"),
        h("div", { className: "dshhr-desc" },
          "重启会重新装载 profile 插件与全部设置；未完成的工作（进行中的回合、活动中的目标）会在新进程里自动继续。"
          + "等待类策略会实时显示进度、可随时取消；重启完成后本页面自动用新凭证重开。"),
        h("div", { className: "dshhr-body" },

          h("div", { className: "dshhr-actions" },
            h("button", {
              type: "button",
              className: "dshhr-btn dshhr-btn-primary",
              disabled: busy,
              onClick: () => { void runRestart(null); },
            }, `按当前策略重启（${POLICY_LABEL[policy] || policy}）`),
            h("button", {
              type: "button",
              className: "dshhr-btn",
              disabled: !pending,
              onClick: () => { void cancelPending(); },
            }, "取消等待中的重启"),
            note ? h("span", { className: "dshhr-fine" }, note) : null,
          ),

          h("div", { className: "dshhr-meta" },
            h("span", { className: `dshhr-badge${pending ? " dshhr-badge-warn" : " dshhr-badge-ok"}` },
              pending ? `等待中：${POLICY_LABEL[pending.policy] || pending.policy}` : "空闲"),
            status ? h("span", null, `运行会话 ${idleness.running} / ${idleness.total}`) : null,
            status ? h("span", null, `进程 PID ${status.pid}`) : null,
            status ? h("span", null, `重启方式 ${status.mode === "self" ? "自拉起" : status.mode}`) : null,
          ),
          status && status.lastOutcome && status.lastOutcome.reason
            ? h("div", { className: "dshhr-fine" }, `上次：${status.lastOutcome.reason}`)
            : null,

          h("div", { className: "dshhr-row-label" }, "策略"),
          h(PolicyOption, {
            value: "now", active: policy === "now", onSelect: selectPolicy,
            title: "立即重启",
            desc: "收到请求后按「退出等待毫秒数」留出回传时间，随即重启。",
          }),
          h(PolicyOption, {
            value: "wait-idle", active: policy === "wait-idle", onSelect: selectPolicy,
            title: "等待全部会话空闲",
            desc: `等所有会话的回合都结束/阻塞后再重启（默认最长等 ${minutes((config && config.waitIdleTimeoutMs) || 600000)} 分钟，超时则取消）。`,
          }),
          h(PolicyOption, {
            value: "notify", active: policy === "notify", onSelect: selectPolicy,
            title: "通知全部会话后再等待",
            desc: "先向所有活跃会话注入提示词，等待指定时长后重启；若期间全部空闲则提前重启。",
          }),
          policy === "notify"
            ? h("div", null,
              h("div", { className: "dshhr-row" },
                h("div", null,
                  h("div", { className: "dshhr-row-label" }, "等待时长（分钟）"),
                  h("div", { className: "dshhr-row-hint" }, "注入提示词后最多等这么久。"),
                ),
                h("input", {
                  className: "dshhr-input", type: "number", min: 3, max: 120,
                  value: minutes((config && config.notifyWaitMs) || 300000),
                  onChange: (event) => { void save({ notifyWaitMs: Math.max(1, Number(event.target.value) || 1) * 60000 }); },
                }),
              ),
              h("div", { className: "dshhr-row" },
                h("div", null,
                  h("div", { className: "dshhr-row-label" }, "全部会话提前空闲时立刻重启"),
                  h("div", { className: "dshhr-row-hint" }, "关闭则一定要等满上面的时长。"),
                ),
                h(Switch, {
                  label: "全部会话提前空闲时立刻重启",
                  on: (config && config.notifyRestartWhenIdle) !== false,
                  onChange: (value) => { void save({ notifyRestartWhenIdle: value }); },
                }),
              ),
            )
            : null,
          policy === "wait-idle"
            ? h("div", { className: "dshhr-row" },
              h("div", null,
                h("div", { className: "dshhr-row-label" }, "最长等待（分钟）"),
                h("div", { className: "dshhr-row-hint" }, "超过则取消本次重启，不会强行打断会话。"),
              ),
              h("input", {
                className: "dshhr-input", type: "number", min: 3, max: 240,
                value: minutes((config && config.waitIdleTimeoutMs) || 600000),
                onChange: (event) => { void save({ waitIdleTimeoutMs: Math.max(1, Number(event.target.value) || 1) * 60000 }); },
              }),
            )
            : null,

          h("div", { className: "dshhr-row-label" }, "注入提示词（统一格式：均以【DSH 系统】开头）"),
          h("div", { className: "dshhr-row-hint" },
            "「重启后继续」用于重启完成后自动继续未完成的工作；「重启前通知」用于 notify 策略，{minutes} 会替换为等待分钟数。"),
          h("div", null,
            h("div", { className: "dshhr-row-label" }, "重启后继续"),
            h("textarea", {
              className: "dshhr-textarea",
              defaultValue: (config && config.continuePrompt) || "",
              onBlur: (event) => {
                const value = String(event.target.value || "").trim();
                if (value !== "" && value !== (config && config.continuePrompt)) void save({ continuePrompt: value });
              },
            }),
          ),
          h("div", null,
            h("div", { className: "dshhr-row-label" }, "重启前通知（notify 策略）"),
            h("textarea", {
              className: "dshhr-textarea",
              defaultValue: (config && config.notifyPrompt) || "",
              onBlur: (event) => {
                const value = String(event.target.value || "").trim();
                if (value !== "" && value !== (config && config.notifyPrompt)) void save({ notifyPrompt: value });
              },
            }),
          ),

          h("div", { className: "dshhr-fine" },
            "协议：重启由插件在被监管的宿主内发起（systemd / 容器等失败重启策略负责拉起），不使用 sudo 或外部脚本。"),
        ),
      );
    }

    function RestartSettingsSection() {
      const [status] = useStatus(true);
      const [config, save, note] = useConfig();
      return h("div", { className: "dshhr-section" },
        h(PermissionCard, { config, save }),
        h(RestartCard, { status, config, save, note }),
        h(LogCard),
      );
    }

    /* ── 统一弹窗（所有提示复用同一个右下角小窗）────────────────────── */
    function RestartPopup() {
      const state = useUi();
      if (state.phase === "idle") return null;
      const ticking = state.phase === "waiting";
      const now = useClock(ticking);
      const source = SOURCE_LABEL[state.source] || "未知";
      const remaining = ticking && state.deadline > 0 ? fmtRemaining(state.deadline - now) : null;

      let title;
      let body;
      let actions = null;

      if (state.phase === "waiting") {
        title = "↻ 重启倒计时";
        body =
          (state.notice ? "⚠ 该重启由 AI 发起，请留意。\n" : "") +
          `发起方：${source}\n` +
          (remaining === null ? "" : `剩余 ${remaining}；`) +
          (state.policy ? `策略：${POLICY_LABEL[state.policy] || state.policy}。\n` : "") +
          "到时自动重启并重开页面，可随时取消。";
        actions = [
          h("button", { type: "button", className: "dshhr-btn", onClick: () => { void cancelPending(); } }, "取消重启"),
          state.notice
            ? h("button", { type: "button", className: "dshhr-btn", onClick: () => setUi({ phase: "idle", message: "" }) }, "知道了")
            : null,
        ];
      } else if (state.phase === "restarting") {
        title = "↻ 重启中";
        body = `发起方：${source}\n进程正在重启（通常 5-30 秒）。完成后本页面会自动用新凭证重开，未完成的工作会自动继续。`;
      } else if (state.phase === "handoff") {
        title = "↻ 重启完成";
        body = "已重启，正在用新凭证重新打开页面…";
      } else {
        title = "⚠ 重启未按预期完成";
        body = state.message || "";
        actions = [
          h("button", {
            type: "button",
            className: "dshhr-btn dshhr-btn-primary",
            onClick: () => setUi({ phase: "idle", message: "" }),
          }, "关闭"),
        ];
      }

      return h("div", { className: "dshhr-pop" },
        h("div", { className: "dshhr-pop-title" }, title),
        h("div", { style: { whiteSpace: "pre-line" } }, body),
        actions ? h("div", { className: "dshhr-actions", style: { marginTop: 10 } }, actions) : null,
      );
    }

    /* ── AI 倒计时重启提醒 + 任何来源重启的自动重开（全局轮询，每 5s）────── */
    let aiAlertSeen = null;
    try { aiAlertSeen = Number(sessionStorage.getItem("dshhr-ai-alert") || 0) || null; } catch { aiAlertSeen = null; }
    let restartBaseline = null;
    function startStatusWatcher() {
      setInterval(() => {
        void (async () => {
          let status = null;
          try { status = await getStatus(); } catch { /* 服务器重启中/未就绪 */ }
          if (status === null) return;

          // 1) 有在途重启时：一旦进程身份变化，自动用新凭证重开页面
          if (restartBaseline !== null && (status.pid !== restartBaseline.pid || status.startedAt !== restartBaseline.startedAt)) {
            restartBaseline = null;
            setUi({ phase: "handoff", message: "" });
            const target = typeof status.url === "string" && status.url !== "" ? status.url : null;
            window.setTimeout(() => { window.location.replace("/"); }, 6000);
            if (target !== null) { window.location.replace(target); return; }
            for (let k = 0; k < 8; k += 1) {
              await sleep(1000);
              try {
                const next = await getStatus();
                if (next !== null && typeof next.url === "string" && next.url !== "") {
                  window.location.replace(next.url);
                  return;
                }
              } catch { /* ignore */ }
            }
            window.location.replace("/");
            return;
          }

          const pending = status.pending ? status.pending : null;
          const inFlight = ui.phase !== "idle" || (pending !== null && pending.phase === "waiting");
          if (inFlight) {
            if (restartBaseline === null) restartBaseline = { pid: status.pid, startedAt: status.startedAt };
          } else {
            restartBaseline = null;
          }

          // 2) AI 发起的等待：右下角弹窗提醒（去重，防刷新重复弹）
          if (ui.phase !== "idle") {
            if (ui.phase === "waiting" && ui.notice === true && pending !== null && pending.phase === "waiting") {
              setUi({ deadline: pending.deadline, source: "tool" });
            }
            return;
          }
          if (pending === null || pending.phase !== "waiting" || pending.source !== "tool") return;
          if (aiAlertSeen !== pending.startedAt) {
            aiAlertSeen = pending.startedAt;
            try { sessionStorage.setItem("dshhr-ai-alert", String(pending.startedAt)); } catch { /* ignore */ }
            setUi({ phase: "waiting", policy: pending.policy, deadline: pending.deadline, notice: true, source: "tool", message: "" });
            try {
              if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                new Notification("DSH 重启请求", {
                  body: `AI 发起了${POLICY_LABEL[pending.policy] || pending.policy}重启（至少 3 分钟后）。如需阻止，请打开设置 → DSH 重启并取消。`,
                });
              }
            } catch { /* 通知不可用时静默 */ }
          }
        })();
      }, 5000);
    }

    /* ── 插件入口 ─────────────────────────────────────────────────────── */
    function apply(ctx) {
      startStatusWatcher();
      ctx.effect(() => {
        const existing = document.getElementById(CSS_ID);
        if (existing !== null) existing.remove();
        const style = document.createElement("style");
        style.id = CSS_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          const mine = document.getElementById(CSS_ID);
          if (mine !== null) mine.remove();
        };
      }, "dsh-harness-restart: stylesheet");

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "harness-restart", order: 160, label: () => "DSH 重启" },
          RestartSettingsSection,
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "harness-restart-overlay", order: 30, label: () => "重启状态" },
          RestartPopup,
        ),
      );
    }

    return { name, inject, apply };
  },
});