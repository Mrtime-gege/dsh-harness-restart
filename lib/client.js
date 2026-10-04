/**
 * dsh-harness-restart v1 —— 客户端侧（browser half，classic script 单文件）。
 * 注册：settings.section「DSH 重启」+ shell.overlay 右下角小窗（所有提示非阻塞、右下角）。
 * 数据：同源 HTTP 直连宿主 /plugins/dsh-harness-restart/*。
 * 硬契约：window.__ModuleLoader__.load({ id, factory })。
 */

window.__ModuleLoader__.load({
  id: "dsh-harness-restart",
  factory: (require) => {
    const react = require("react");
    const h = react.createElement;
    const inject = ["slots"];
    const name = "dsh-harness-restart";
    const BASE = "/plugins/dsh-harness-restart";
    const CSS_ID = "dshhr-v1-styles";

    const CSS = `
.dshhr-section { display: flex; flex-direction: column; gap: 14px; max-width: 760px; padding: 2px 2px 28px; }
.dshhr-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px 18px; }
.dshhr-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); margin-bottom: 4px; }
.dshhr-desc { font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.dshhr-body { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.dshhr-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.dshhr-row-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
    .dshhr-subtitle { margin: 12px 0 2px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, rgba(128,128,128,0.9)); letter-spacing: 0.04em; }
.dshhr-row-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; line-height: 1.5; }
.dshhr-input { font: inherit; font-size: 13px; width: 96px; padding: 5px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshhr-textarea { font: inherit; font-size: 12.5px; width: 100%; min-height: 56px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); resize: vertical; line-height: 1.6; box-sizing: border-box; }
.dshhr-switch { position: relative; flex: none; width: 38px; height: 22px; padding: 0; border: none; border-radius: 11px; background: var(--dsw-alias-border-l2); cursor: pointer; transition: background .15s ease; }
.dshhr-switch.is-on { background: var(--dsw-alias-brand-primary); }
.dshhr-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s ease; }
.dshhr-switch.is-on::after { transform: translateX(16px); }
.dshhr-badge { display: inline-block; font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-secondary); }
.dshhr-badge.is-danger { background: rgba(200,60,60,.16); color: var(--dsw-alias-state-error-primary, #d44); }
.dshhr-btn { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.dshhr-btn-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.dshhr-log { font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; max-height: 220px; overflow: auto; }
.dshhr-overlay { position: fixed; right: 16px; bottom: 16px; z-index: 9998; display: flex; flex-direction: column; gap: 10px; max-width: 360px; }
.dshhr-toast { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; box-shadow: 0 8px 28px rgba(0,0,0,.24); }
.dshhr-toast-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); margin-bottom: 6px; }
.dshhr-toast-body { font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dshhr-toast-actions { margin-top: 10px; display: flex; gap: 8px; }
`;

    const SOURCE_LABEL = {
      button: "设置页按钮",
      tool: "AI（模型工具）",
      command: "/restart 命令",
      scheduled: "定时计划",
    };
    const TRIGGER_LABEL = { now: "立即", delay: "等待后" };

    /* ── api ─────────────────────────────────────────────────────────── */
    async function api(path, init) {
      const response = await fetch(`${BASE}${path}`, {
        cache: "no-store",
        headers:
          init && init.body
            ? { "content-type": "application/json" }
            : undefined,
        ...init,
      });
      try {
        return { status: response.status, body: await response.json() };
      } catch {
        return { status: response.status, body: null };
      }
    }
    const getStatus = () => api("/status").then((r) => r.body);
    const getConfig = () => api("/config").then((r) => r.body);
    const postRestart = (payload) =>
      api("/restart", { method: "POST", body: JSON.stringify(payload) });
    const postCancel = () =>
      api("/cancel", { method: "POST", body: JSON.stringify({}) });
    const approveRestart = () =>
      api("/approve", { method: "POST", body: JSON.stringify({}) });
    const declineRestart = () =>
      api("/decline", { method: "POST", body: JSON.stringify({}) });
    const postConfig = (patch) =>
      api("/config", { method: "POST", body: JSON.stringify({ patch }) });
    const getLog = (lines) =>
      api(`/log?lines=${lines || 200}`).then(
        (r) => (r.body && r.body.lines) || [],
      );

    /* ── 小窗状态机（右下角非阻塞）────────────────────────────────── */
    let toast = { kind: "none" }; // {kind:'waiting'|'restarting'|'info'|'error', ...}
    const listeners = new Set();
    const notify = (next) => {
      toast = next;
      for (const fn of listeners) fn(toast);
    };
    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    let busy = false;
    async function runRestart(payload) {
      if (busy) return;
      busy = true;
      try {
        const r = await postRestart(payload);
        if (r.status === 202 && r.body && r.body.phase === "waiting") {
          notify({
            kind: "waiting",
            source: r.body.source,
            trigger: r.body.trigger,
            etaMs: r.body.etaMs,
            id: r.body.id,
            at: Date.now(),
          });
        } else if (
          r.status === 409 ||
          r.status === 400 ||
          (r.body && r.body.ok === false)
        ) {
          notify({
            kind: "error",
            message: (r.body && r.body.error) || "请求被拒绝",
          });
        }
      } catch (error) {
        notify({
          kind: "error",
          message: String((error && error.message) || error),
        });
      }
      busy = false;
    }

    async function startCounting() {
      const tick = () => {
        const t = toast;
        if (t.kind === "waiting" && t.etaMs != null) {
          const left = Math.max(0, t.etaMs - (Date.now() - t.at));
          for (const fn of listeners) fn({ ...t, left });
          if (left <= 0) {
            /* 等待宿主继续处理 */
          }
        }
      };
      setInterval(tick, 1000);
    }

    /* ── 全局轮询：跟随宿主 pending / lastOutcome ───────────────────── */
    async function startWatcher() {
      let lastPid = null;
      setInterval(async () => {
        try {
          const st = await getStatus();
          if (!st) return;
          if (st.pid && lastPid && st.pid !== lastPid) {
            notify({ kind: "info", message: "DSH 已重启（凭证已自动重开）" });
          }
          if (st.pid) lastPid = st.pid;
          if (
            st.pending &&
            st.pending.phase === "awaiting-confirm" &&
            st.pending.by === "ai" &&
            toast.kind !== "confirm"
          ) {
            notify({
              kind: "confirm",
              source: st.pending.source,
              trigger: st.pending.trigger,
              by: st.pending.by,
              etaMs: st.pending.etaMs,
              id: st.pending.id,
              at: Date.now(),
            });
          }
          if (
            st.pending &&
            st.pending.phase === "waiting" &&
            toast.kind !== "waiting"
          ) {
            notify({
              kind: "waiting",
              source: st.pending.source,
              trigger: st.pending.trigger,
              etaMs: st.pending.etaMs,
              id: st.pending.id,
              at: Date.now(),
            });
          }
          if (!st.pending && (toast.kind === "waiting" || toast.kind === "confirm"))
            notify({ kind: "info", message: "等待结束（已重启、已确认或被取消）" });
        } catch {
          /* 服务未就绪 */
        }
      }, 3000);
    }

    /* ── 组件 ────────────────────────────────────────────────────────── */
    function Switch(props) {
      return h("button", {
        className: "dshhr-switch" + (props.on ? " is-on" : ""),
        "aria-label": props.label || "开关",
        onClick: () => {
          if (props.onChange) props.onChange(!props.on);
        },
      });
    }

    function RestartPopup() {
      const [state, setState] = react.useState(toast);
      react.useEffect(() => subscribe((t) => setState({ ...t })), []);
      if (state.kind === "none") return null;
      const title =
        state.kind === "confirm"
          ? "AI 请求重启（需确认）"
          : state.kind === "waiting"
            ? "重启倒计时"
            : state.kind === "restarting"
              ? "正在重启"
              : state.kind === "error"
                ? "重启失败"
                : "DSH 重启";
      let body = state.message || "";
      if (state.kind === "confirm") {
        body = `AI（${TRIGGER_LABEL[state.trigger] || state.trigger}）请求重启，请确认是否执行；不在倒计时内确认将自动取消。`;
      }
      if (state.kind === "waiting") {
        const sec =
          state.left == null
            ? Math.round((state.etaMs || 0) / 1000)
            : Math.round(state.left / 1000);
        body = `发起方：${SOURCE_LABEL[state.source] || state.source} ｜ 方式：${TRIGGER_LABEL[state.trigger] || state.trigger} ｜ 剩余 ${sec} 秒`;
      }
      if (state.kind === "info") body = state.message || "";
      return h(
        "div",
        { className: "dshhr-overlay" },
        h(
          "div",
          { className: "dshhr-toast" },
          h("div", { className: "dshhr-toast-title" }, title),
          h("div", { className: "dshhr-toast-body" }, body),
          state.kind === "confirm" &&
            h(
              "div",
              { className: "dshhr-toast-actions" },
              h(
                "button",
                {
                  className: "dshhr-btn dshhr-btn-primary",
                  onClick: () => {
                    void approveRestart();
                    notify({ kind: "info", message: "已确认，进入重启等待" });
                  },
                },
                "确认重启",
              ),
              h(
                "button",
                {
                  className: "dshhr-btn",
                  onClick: () => {
                    void declineRestart();
                    notify({ kind: "info", message: "已拒绝 AI 重启请求" });
                  },
                },
                "拒绝",
              ),
            ),
          state.kind === "waiting" &&
            h(
              "div",
              { className: "dshhr-toast-actions" },
              h(
                "button",
                {
                  className: "dshhr-btn",
                  onClick: () => {
                    void postCancel();
                    notify({ kind: "info", message: "已取消" });
                  },
                },
                "取消重启",
              ),
            ),
          (state.kind === "info" || state.kind === "error") &&
            h(
              "div",
              { className: "dshhr-toast-actions" },
              h(
                "button",
                {
                  className: "dshhr-btn",
                  onClick: () => notify({ kind: "none" }),
                },
                "知道了",
              ),
            ),
        ),
      );
    }

    function SettingsCard() {
      const [status, setStatus] = react.useState(null);
      const [config, setConfig] = react.useState(null);
      const [log, setLog] = react.useState(null);
      const [delaySec, setDelaySec] = react.useState(300);
      const refresh = react.useCallback(async () => {
        try {
          const [st, cfg] = await Promise.all([getStatus(), getConfig()]);
          setStatus(st);
          setConfig(cfg && cfg.config);
        } catch (error) {
          // 避免 fire-and-forget 异常让页面停在旧状态
        }
      }, []);
      react.useEffect(() => {
        void refresh();
        const t = setInterval(refresh, 4000);
        return () => clearInterval(t);
      }, [refresh]);

      const fetchLog = async () => {
        setLog(await getLog(200));
      };
      const save = async (patch) => {
        // 乐观更新：先本地合并，立即反映到页面；失败再回滚并提示
        const mergePatch = (prev) => {
          if (!prev) return prev
          const merged = { ...prev }
          for (const [k, v] of Object.entries(patch)) {
            if (v !== null && typeof v === 'object' && !Array.isArray(v) && merged[k] !== null && typeof merged[k] === 'object' && !Array.isArray(merged[k])) {
              merged[k] = { ...merged[k], ...v }
            } else {
              merged[k] = v
            }
          }
          return merged
        }
        setConfig((prev) => mergePatch(prev))
        try {
          const r = await postConfig(patch);
          if (r.body && r.body.ok === true) {
            notify({ kind: 'info', message: '配置已保存并立即生效' });
            void refresh();
          } else {
            setConfig((prev) => mergePatch(prev));
            void refresh();
            notify({ kind: 'error', message: (r.body && r.body.error) || '保存失败' });
          }
        } catch (error) {
          setConfig((prev) => mergePatch(prev));
          void refresh();
          notify({ kind: 'error', message: String(error && error.message || error) });
        }
      };

      if (!status || !config)
        return h(
          "div",
          { className: "dshhr-section" },
          h("div", { className: "dshhr-desc" }, "加载中…"),
        );

      const ai = config.ai || {};
      const pa = (config.permissions && config.permissions.ai) || {};
      const ph = (config.permissions && config.permissions.human) || {};
      const schedule = status.schedule || [];
      const callbacks = status.callbacks || [];
      const pre = config.preRestart || {};
      const postRestart = config.postRestart || {};
      const pending = status.pending || null;

      return h(
        "div",
        { className: "dshhr-section" },
        /* 权限：AI 控制 / 人类控制 */
        h(
          "div",
          { className: "dshhr-card" },
          h("div", { className: "dshhr-title" }, "权限控制"),
          h(
            "div",
            { className: "dshhr-body" },
            h("div", { className: "dshhr-subtitle" }, "AI 控制"),
            h(
              "div",
              { className: "dshhr-row" },
              h("div", null, h("div", { className: "dshhr-row-label" }, "允许 AI 发起重启")),
              h(Switch, {
                on: pa.enabled === true,
                onChange: (v) => save({ permissions: { ai: { enabled: v } } }),
              }),
            ),
            h(
              "div",
              { className: "dshhr-row" },
              h("div", null, h("div", { className: "dshhr-row-label" }, "两段式挑战认证")),
              h(Switch, {
                on: pa.challenge !== false,
                onChange: (v) => save({ permissions: { ai: { challenge: v } } }),
              }),
            ),
            h(
              "div",
              { className: "dshhr-row" },
              h("div", null, h("div", { className: "dshhr-row-label" }, "需人类确认后才执行")),
              h(Switch, {
                on: pa.humanConfirm === true,
                onChange: (v) => save({ permissions: { ai: { humanConfirm: v } } }),
              }),
            ),
            h(
              "div",
              { className: "dshhr-row" },
              h("div", null, h("div", { className: "dshhr-row-label" }, "允许 AI 立即重启（now）")),
              h(Switch, {
                on: (pa.triggers || {}).now === true,
                onChange: (v) => save({ permissions: { ai: { triggers: { now: v } } } }),
              }),
            ),
            h(
              "div",
              { className: "dshhr-row-hint" },
              `AI delay 区间：${Math.round((pa.delayRangeMs || [180000, 3600000])[0] / 60000)} 分钟 ~ ${Math.round((pa.delayRangeMs || [180000, 3600000])[1] / 3600000)} 小时；推荐 ${Math.round((pa.recommendDelayMs || 300000) / 60000)} 分钟`,
            ),
            h("div", { className: "dshhr-subtitle" }, "人类控制"),
            h(
              "div",
              { className: "dshhr-row" },
              h("div", null, h("div", { className: "dshhr-row-label" }, "允许手动重启（设置页/HTTP/命令）")),
              h(Switch, {
                on: ph.enabled === true,
                onChange: (v) => save({ permissions: { human: { enabled: v } } }),
              }),
            ),
            h(
              "div",
              { className: "dshhr-row" },
              h("div", null, h("div", { className: "dshhr-row-label" }, "允许立即重启（now）")),
              h(Switch, {
                on: (ph.triggers || {}).now !== false,
                onChange: (v) => save({ permissions: { human: { triggers: { now: v } } } }),
              }),
            ),
            h(
              "div",
              { className: "dshhr-row" },
              h("div", null, h("div", { className: "dshhr-row-label" }, "人类可取消 AI 发起的重启（人优先）")),
              h(Switch, {
                on: ph.cancelAi !== false,
                onChange: (v) => save({ permissions: { human: { cancelAi: v } } }),
              }),
            ),
            h(
              "div",
              { className: "dshhr-row-hint" },
              "来源入口：" + ["settingsPage", "http", "command"].map((k) => `${k} ${(ph.sources || {})[k] !== false ? "✓" : "✗"}`).join(" · "),
            ),
          ),
        ),
        /* 触发 */
        h(
          "div",
          { className: "dshhr-card" },
          h("div", { className: "dshhr-title" }, "触发重启"),
          h(
            "div",
            { className: "dshhr-body" },
            h(
              "div",
              { className: "dshhr-row" },
              h(
                "button",
                {
                  className: "dshhr-btn dshhr-btn-primary",
                  onClick: () => void runRestart({ trigger: "now" }),
                },
                "立即重启",
              ),
              h(
                "div",
                { className: "dshhr-row" },
                h("input", {
                  className: "dshhr-input",
                  type: "number",
                  min: 1,
                  defaultValue: delaySec,
                  onChange: (e) => setDelaySec(Number(e.target.value)),
                }),
                h(
                  "button",
                  {
                    className: "dshhr-btn",
                    onClick: () =>
                      void runRestart({
                        trigger: "delay",
                        delayMs:
                          (Number.isFinite(delaySec) && delaySec > 0
                            ? delaySec
                            : 5) * 1000,
                      }),
                  },
                  `等待 ${delaySec || 5} 秒后重启`,
                ),
              ),
            ),
            pending &&
              h(
                "div",
                { className: "dshhr-row-hint" },
                `进行中：${TRIGGER_LABEL[pending.trigger] || pending.trigger}（${SOURCE_LABEL[pending.source] || pending.source}） ${Math.round((pending.etaMs || 0) / 1000)}s ｜ `,
                h(
                  "button",
                  {
                    className: "dshhr-badge",
                    onClick: () => void postCancel(),
                  },
                  "取消",
                ),
              ),
          ),
        ),
        /* 重启前 / 重启后策略 */
        h(
          "div",
          { className: "dshhr-card" },
          h("div", { className: "dshhr-title" }, "重启前 / 重启后策略"),
          h(
            "div",
            { className: "dshhr-body" },
            h(
              "div",
              { className: "dshhr-row" },
              h(
                "div",
                null,
                h(
                  "div",
                  { className: "dshhr-row-label" },
                  "重启前（PRE）：",
                  h(
                    "span",
                    { className: "dshhr-badge" },
                    pre.mode || "waitAllOrForce",
                  ),
                ),
                h(
                  "div",
                  { className: "dshhr-row-hint" },
                  pre.forceAfterMs === -1
                    ? "等所有会话结束（无限）"
                    : `forceAfter=${Math.round((pre.forceAfterMs || 30000) / 1000)}s`,
                ),
              ),
              h(
                "button",
                {
                  className: "dshhr-btn",
                  onClick: () =>
                    void save({
                      preRestart: {
                        mode:
                          pre.mode === "immediate"
                            ? "waitAllOrForce"
                            : "immediate",
                        forceAfterMs:
                          pre.mode === "immediate"
                            ? 30000
                            : pre.forceAfterMs || 30000,
                      },
                    }),
                },
                "切换 immediate/等待",
              ),
            ),
            h(
              "div",
              { className: "dshhr-row" },
              h(
                "div",
                null,
                h(
                  "div",
                  { className: "dshhr-row-label" },
                  "重启后（POST）：",
                  h(
                    "span",
                    { className: "dshhr-badge" },
                    postRestart.mode || "resumeAll",
                  ),
                ),
              ),
              h(
                "div",
                { className: "dshhr-row-hint" },
                "渐进恢复：等 1 分钟 + 每 5 秒启动一个（可配）",
              ),
            ),
          ),
        ),
        /* 调度回调 + 已注册回调 */
        h(
          "div",
          { className: "dshhr-card" },
          h(
            "div",
            { className: "dshhr-title" },
            "调度回调（每分钟第 0 秒求值）",
          ),
          h(
            "div",
            { className: "dshhr-desc" },
            "回调条目：官方预设（daily/weekly…）或自定义脚本（完全信任，危险）。条目在 settings.yaml 的 schedule 数组里新增；此处展示。",
          ),
          h(
            "div",
            { className: "dshhr-body" },
            schedule.length === 0
              ? h("div", { className: "dshhr-row-hint" }, "（未配置调度条目）")
              : schedule.map((e) =>
                  h(
                    "div",
                    { className: "dshhr-row", key: e.id },
                    h(
                      "div",
                      null,
                      h("div", { className: "dshhr-row-label" }, e.id),
                      h("div", { className: "dshhr-row-hint" }, e.describe),
                    ),
                    h(
                      "span",
                      {
                        className:
                          "dshhr-badge" +
                          (e.kind === "script" ? " is-danger" : ""),
                      },
                      e.kind === "script" ? "脚本·危险" : "预设",
                    ),
                  ),
                ),
          ),
          h(
            "div",
            { className: "dshhr-title", style: { marginTop: 12 } },
            "已注册重启后回调（方案 B）",
          ),
          h(
            "div",
            { className: "dshhr-body" },
            callbacks.length === 0
              ? h("div", { className: "dshhr-row-hint" }, "（无）")
              : callbacks.map((c) =>
                  h(
                    "div",
                    { className: "dshhr-row", key: c.callbackId },
                    h(
                      "div",
                      null,
                      h("div", { className: "dshhr-row-label" }, c.callbackId),
                      h(
                        "div",
                        { className: "dshhr-row-hint" },
                        c.description || "",
                      ),
                    ),
                  ),
                ),
          ),
        ),
        /* 日志 */
        h(
          "div",
          { className: "dshhr-card" },
          h("div", { className: "dshhr-title" }, "日志（全事件，不论成败）"),
          h(
            "div",
            { className: "dshhr-body" },
            h(
              "div",
              { className: "dshhr-row" },
              h(
                "button",
                { className: "dshhr-btn", onClick: fetchLog },
                "刷新尾部",
              ),
              h(
                "button",
                {
                  className: "dshhr-btn",
                  onClick: () => {
                    void api("/log/open");
                  },
                },
                "打开日志目录",
              ),
            ),
            log && h("div", { className: "dshhr-log" }, log.join("\n")),
          ),
        ),
      );
    }

    /* ── apply ───────────────────────────────────────────────────────── */
    function apply(ctx, _config) {
      const ensureCss = () => {
        if (!document.getElementById(CSS_ID)) {
          const style = document.createElement("style");
          style.id = CSS_ID;
          style.textContent = CSS;
          document.head.appendChild(style);
        }
      };
      // 契约：inject(槽名, 工厂) 包裹 + register({ name, id, ... }, 组件) 两参。
      // 槽不存在时安静跳过 —— settings.section 仅部分 DSH 版本声明了（对齐 dsh-agent-shell 的防御）。
      try {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-harness-restart",
              order: 160,
              label: "DSH 重启",
              title: "DSH 重启",
            },
            SettingsCard,
          ),
        );
      } catch (error) {
        console.error(
          "dsh-harness-restart: settings card not registered: " +
            String(error && error.message ? error.message : error),
        );
      }
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "harness-restart-overlay", label: "DSH 重启" },
          RestartPopup,
        ),
      );
      startCounting();
      startWatcher();
      ensureCss();
      return { name };
    }

    return { name, inject, apply };
  },
});
