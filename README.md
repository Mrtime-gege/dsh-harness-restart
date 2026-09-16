# dsh-harness-restart

Restart the whole DeepSeek Harness process from a **settings page** (no sidebar button, no accidental clicks): restart button, three restart policies, AI permission switches with a **two-step challenge authentication**, `dsh_restart` + `dsh_restart_cancel` model tools, `/restart` command, an in-settings **log viewer** with one-click open, environment-adaptive restart (supervisor self-exit vs. detached respawn), post-restart **auto-continue** of unfinished sessions, and **credential-rotation self-healing** (the page reopens itself with the new token).

## Features

- Settings → **“DSH 重启”** page (top → bottom: 权限 / 重启+策略 / 日志), styled with `--dsw-alias-*` theme tokens (light & dark).
  - One-click **“重启（按当前策略）”** + **“取消等待中的重启”**.
  - Three **restart policies** with live progress and a countdown mini-popup (bottom-right, non-blocking) showing **who initiated** the restart and **remaining time**.
  - **“允许 AI 使用重启功能”** and **“AI 发起重启需要二次认证”** switches (enforced server-side).
  - **日志** card: live tail, auto-refresh, one-click open of the source file.
- **Model tool `dsh_restart`** — AI schedules a restart with **two-step authentication**: the first call returns a 16-char challenge token + guidance; the second call must echo the **same token and the exact same `policy`** — only then does the restart actually start. AI cannot use the `now` policy; waiting policies have a hard **3-minute minimum countdown**, and the user gets a bottom-right popup they can cancel.
- **`dsh_restart_cancel`** — cancels a pending restart **only if the AI itself initiated it**.
- **Post-restart auto-continue** — before restarting, all unfinished root sessions (in-flight turn ∪ active goal) are recorded in `$DSH_HOME/dsh-resume.json`; after boot each is injected with a “continue” prompt (followup for live agents, `sessionController.prompt` fallback for cold ones), then the marker is cleared.
- **Credential-rotation self-healing** — dsh rotates its launch token every boot; the probe route hands the page the new `authenticatedUrl()` and the page reopens itself. Zero manual URL copying. Works for both page-initiated and AI-initiated restarts (while a page is open).

## Restart policies

| Policy | Behavior |
|---|---|
| `now` | Restart immediately after the configured exit delay. **Page/`/restart` only — AI cannot use it.** |
| `wait-idle` | Polls all root sessions and restarts once every turn is finished/blocked; cancels on timeout (default 10 min, min 3 min). AI: even if already idle, waits at least 3 min. |
| `notify` | Injects a notice prompt into all active sessions (“DSH 将在约 N 分钟后重启…”, `{minutes}` placeholder, editable), then restarts after `notifyWaitMs` (default 5 min, min 3 min); restarts early if everything becomes idle (AI: still at least 3 min). |

All waiting policies expose live progress and a **cancel** action.

## How the restart happens (environment-adaptive, zero external commands)

| Run shape | Detection | Restart path |
|---|---|---|
| systemd unit | `INVOCATION_ID` **and** own cgroup under `/system.slice/` | Write resume marker → exit `125` → systemd `Restart=on-failure` relaunches the same ExecStart |
| container with a restart policy | `/proc/1` cgroup/comm | Same: non-zero exit, orchestrator relaunches |
| bare run (terminal, npx, no supervisor) | no supervisor markers | A detached helper re-spawns the new instance with the same argv after the old process exits and frees the port (Windows: hidden console) |

No sudo, no bash scripting, no external watchdog. «Boot failure» falls back to the supervisor's own restart policy (systemd: 5 attempts / 10 s).

## Credential-rotation recovery (the easy part to get wrong)

dsh rotates the launch token every boot, so the old page can never recover by itself. The plugin uses core's two official interfaces: `ctx.connection.requestRejection()` (Host/Origin fence + browser auth for another web route) and `ctx.connection.authenticatedUrl()` (fresh token URL). The client polls the **public, local-only** probe route, and on identity change navigates to the new URL — the server mints a fresh cookie and 303s to clean `/`.

## Security boundaries

- **Core 403 is never downgraded**; only a **401 (rotated cookie)** is allowed to fall back to *local/private-IP literal + same-origin* (DNS rebinding via domain authorities is rejected).
- **Mutation routes** (restart / config / cancel / open-log) require full core auth (`requestRejection` must pass); loopback + same-origin when the connection service is unavailable.
- The probe/log routes are readable without credentials **by design** (required for recovery) but only from loopback/private-IP authorities.
- `POST /config` is strictly validated key-by-key; out-of-range values are **rejected with an error, never silently clamped** (`restartDelayMs 0–60000ms`; `waitIdleTimeoutMs` / `notifyWaitMs` `180000–86400000ms`; booleans strict; text non-empty ≤ 2000 chars).
- AI restarts: two-step challenge (16-char, one-time, 5 min TTL) **bound to the exact first-call `policy`**, plus the hard 3-minute countdown and a user-visible popup.

## Limitations (read before using)

1. **AI cannot restart immediately** (`now` is page-only) — by design, to protect sessions.
2. The **systemd automatic-recovery path requires the supervisor's `Restart=on-failure`** (or a container restart policy). If your deployment has *no* supervisor with a restart policy (bare `dsh web` in a terminal), the plugin **does not provide crash daemons**: it restarts on request (helper respawn), but a crash has no one to relaunch it — run it under a supervisor or inside a restart loop.
3. A page is auto-reopened only while a page is open at restart time (the watcher runs in the browser). No page open → nobody navigates; open the URL fresh.
4. Restarting **interrupts all sessions and connections**; an in-flight assistant stream may lose its last tokens (turn is marked `interrupted`) — history is never corrupted.
5. Sessions that were merely *queued* (not yet durable) lose that queue on any restart — this is core dsh behavior, not something the plugin changes.
6. The resume marker covers **root sessions with an in-flight turn or an active goal**; everything else is left alone (the UI reopens them as usual).
7. The probe/log routes intentionally refuse **domain-based** access (LAN IP literals and loopback only) — remote-tunneled setups cannot use auto-recovery/log-open (manual URL from the log instead).
8. **Web platform only** (TUI/desktop are out of scope); single-harness assumption — two instances sharing one `$DSH_HOME` would share the resume marker/log.
9. The challenge is in-memory: a plugin reload (HMR of composition files) or a manual restart resets it — re-issue by calling the tool again.
10. No destructive operations (e.g. “clear sessions then restart”) are provided — deliberately.

## Dependencies

- **Runtime**: Node >= 20; dsh >= 0.1.5-rc.1 (verified baseline) running the **web** profile (`dsh web`).
- **Imported packages** (all **optional peerDependencies**, resolved against the DSH runtime's single copy — never a second copy, see [#1337](https://github.com/deepseek-ai/deepseek-harness/discussions/1337)): `@deepseek-ai/dsh-tools` (`defineTool`), `@deepseek-ai/dsh-llm` (`createUserMessage`), `@deepseek-ai/schemastery` (config schema).
- **Services consumed via `ctx` when present** (each degrades gracefully if missing): `tools`, `agents`, `webServer`, `commands`, `settings`, `sessionController`, `goals`, `connection`.
- **Runtime files** written under `$DSH_HOME`: `dsh-resume.json` (resume marker), `dsh-harness-restart.log` (events + debug).
- **No sudo / no bash scripts / no watchdog / no npm runtime dependencies.**

## Installation

### One-liner (recommended, after the package is published)

```sh
# from GitHub
dsh plugin --profile web add github:<owner>/dsh-harness-restart

# or from npm (once published)
dsh plugin --profile web add dsh-harness-restart
```

Then **restart DSH once** to activate (the plugin manages subsequent restarts itself).

### For AI agents (hand this checklist to your agent)

1. Run: `dsh plugin --profile web add github:<owner>/dsh-harness-restart` (or the npm variant).
2. If the network blocks pnpm fetches, fall back to editing `profiles/<profile>/package.json` manually: add `"dsh-harness-restart": "file:/path/to/dsh-harness-restart"` to `dependencies` and `"dsh-harness-restart"` to `dsh.profile.bundles`, then run `pnpm install` in the profile directory.
3. Verify the bundle resolved: `dsh --profile web --dump-config | grep -c harness-restart` should be ≥ 1.
4. Restart DSH once (e.g. `sudo systemctl restart dsh-web.service` or restart the terminal `dsh web`).
5. Verify: open Settings → **“DSH 重启”**. The AI may then call `dsh_restart` with `policy: wait-idle|notify`, follow the returned challenge token, and the popup shows “发起方：AI（模型工具）” with the countdown.

### Manual install

1. Make sure `dsh` is installed (`npm i -g @deepseek-ai/dsh`, Node >= 20).
2. Decide the source: GitHub tag / npm package / local checkout (see One-liner).
3. Add the dependency and bundle entry in `profiles/<profile>/package.json` (the `file:` form is shown in the AI section; for npm/GitHub `dsh plugin … add` does this for you).
4. `cd ~/.dsh/profiles/<profile> && pnpm install` (or run via `dsh plugin`).
5. Restart DSH once.

## Compatibility

- Verified against `dsh 0.1.5-rc.1`; declared as `dsh.engines.dsh >= 0.1.5-rc.1`. API drift is possible in 0.1.x — see the compatibility matrix in CHANGELOG before upgrading dsh.
- Tests: `npm test` (unit, 85 assertions) and `npm run test:profile` (isolated real-install smoke) — both offline-safe, no live instance touched.

## Credits

- Restart mechanism, identity probe and auto-continue follow the patterns of [anweat/dsh-restart](https://github.com/anweat/dsh-restart) (MIT); the detached relaunch helper is an adaptation of its `relaunch-helper` (attribution is also embedded in `lib/core.js`; the full upstream MIT text lives in the dev repository's `NOTICE`).
- Settings-page placement idea inspired by [1123762794/dsh-web-restart](https://github.com/1123762794/dsh-web-restart).

## License

MIT — see [LICENSE](./LICENSE).