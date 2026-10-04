# dsh-harness-restart

A host plugin that **restarts the DeepSeek Harness (dsh) process and automatically continues unfinished work** — with an approval gate for AI-initiated restarts, schedule/script callbacks, a receipt-based progressive restore of registered callbacks (scheme B), a simulate-only drill mode, and a self-healing restart path that works both under a supervisor and in bare runs.

Built and verified against **dsh 0.2.0** (tested on 0.2.0-rc.2; legacy v0.1.x config keys are mapped automatically).

---

## Features

- **Four-layer restart engine** — TRIGGER → APPROVAL → PRE → EXIT → POST:
  1. **Trigger**: manual button/HTTP, AI tool, or schedule callbacks (official presets `now` / `delay` / `daily` / `weekly` / `immediate` / `waitSeconds` / `waitAllOrForce`, plus user **JavaScript callbacks** with full-trust warning + audit).
  2. **Approval**: AI-initiated restarts require a two-step challenge (16-hex token must be echoed); AI is restricted to `delay` inside `ai.delayRangeMs` (default 3 min–1 h), `now` is off by default.
  3. **PRE**: decide when to actually leave — `immediate`, `waitSeconds(N)`, or `waitAllOrForce` (idle-wait with force timeout; `-1` = wait forever). Sub-agents (subagent children, Agent Teams teammates) are part of the idle snapshot via `agents.list()`.
  4. **EXIT → POST**: write the resume marker, then restart; after boot, restore unfinished sessions and progressive callback sessions.
- **Receipt-based restore (scheme B)** — `dsh_restart_register_callback` lets any session register a “continue this task after restart” callback; after boot the plugin waits `bootRestoreDelayMs` (1 min), then wakes **one callback session every `restoreStaggerMs`** (5 s). Each restored session must ack via `dsh_restart_callback_done`; unacked callbacks get one reminder after `callbackUnackTimeoutMs` (30 min), then `callback-unacked`.
- **AI tools** — `dsh_restart`, `dsh_restart_cancel`, `dsh_restart_register_callback`, `dsh_restart_callback_done`. Strict validation, never clamps out-of-range values.
- **Schedule engine** — minute-boundary detection (250 ms heartbeat, jitter-proof); every minute the registered callbacks are evaluated once.
- **Self-healing restart (double insurance)** — before EXIT the plugin always detaches a **self-healing helper** and then exits the old process:
  1. wait up to 60 s for the port to free;
  2. if a **healthy dsh** already owns the port (e.g. systemd relaunched it) → yield; if only a non-dsh process holds it → keep trying;
  3. otherwise relaunch with the original argv + **health probe** (30 s) and **up to 3 retries**, logging every attempt;
  4. supervisor mode (systemd `Restart=on-failure` / container) still works: the helper yields when the supervisor wins.
- **Simulate-only drill mode** — `simulateOnly: true` in config or `DSH_RESTART_SIMULATE=1` in the env: finalize emits `restart-simulated` and runs the restore flow **in the same process without exiting**. `/status` exposes `simulate: true`.
- **0.2.0-native integrations** — event-driven restore via `agent/created` (with `SessionStartSource`) instead of blind waiting; `app-boot/config-reload` is observed and surfaced as `lastConfigReloadAt`; legacy v0.1.x flat config keys are translated automatically.
- **WebUI settings page** — “DSH 重启” card (permissions / PRE / POST / schedules / callbacks / log) with optimistic updates, plus a bottom-right overlay popup for pending restarts (non-blocking; default prefix `【DSH 重启】`).

---

## Prerequisites

The plugin runs **inside dsh** (it is a Cordis host plugin), so start from a working dsh install — **do not** install Node yourself:

- A running **dsh ≥ 0.1.5** (0.2.x recommended; this plugin is tested on 0.2.0-rc.2). dsh already bundles the Node runtime, and the dsh web UI is reachable at its configured port (default `3080`).
- A **profile** for that instance whose `node_modules` and composition patch (`cordis.patch.yml`) you can write to — typically `$DSH_HOME/profiles/<name>/`.
- No **other process squats the dsh web port** (a second instance would make the restart helper yield instead of relaunching).
- **Bare runs (no supervisor)** need an external keeper for crash recovery: only *requested* restarts self-heal via the detached helper; an unexpected kill before the helper is armed has no relauncher. Prefer `systemd` with `Restart=on-failure` or a container that restarts the process (the plugin then exits with code 125 to trigger it).

---

## Install

### Option A — from npm (after publication)

```bash
cd "$DSH_HOME/profiles/<your-profile>"     # e.g. ~/.dsh/profiles/web
pnpm add dsh-harness-restart               # or: npm install dsh-harness-restart
```

### Option B — offline / from a tarball

```bash
cd "$DSH_HOME/profiles/<your-profile>"
pnpm add ./dsh-harness-restart-0.1.0.tgz
# or place the package directory directly:
#   node_modules/dsh-harness-restart/
```

### Enable the plugin row

Insert a row into the profile composition patch (`profiles/<name>/cordis.patch.yml`):

```yaml
- insert:
    - id: harness-restart
      name: 'dsh-harness-restart'
      config: {}          # defaults; see the configuration table below
```

Then **restart dsh**, and open Settings → **“DSH 重启”**. Verify the file landed with:

```bash
dsh --profile <your-profile> --dump-config | grep -A3 harness-restart
```

Peer requirements (all satisfied by dsh ≥ 0.1.5 / 0.2.0, no extra install needed):

```
@deepseek-ai/cordis    ^4.0.2
@deepseek-ai/dsh-tools >=0.0.1-rc.1
@deepseek-ai/dsh-llm   >=0.0.1-rc.1
@deepseek-ai/schemastery ^3.18.0
react                  ^18.2.0
```

---

## Configuration

All keys are optional. Priority: **runtime overrides file** (`$DSH_HOME/dsh-harness-restart-v1.json`) > **patch config** (`cordis.patch.yml` row) > **defaults**. Out-of-range values are **rejected with an error** (never clamped); a corrupted overrides file falls back with visible `warnings` and never bricks startup.

| Key | Default | Meaning |
|---|---|---|
| `ai.restartEnabled` | `true` | Allow the AI to trigger restarts |
| `ai.challengeEnabled` | `true` | Two-step challenge for AI restarts |
| `ai.allowNow` | `false` | Allow AI to use `now` |
| `ai.delayRangeMs` | `[180000, 3600000]` | AI `delay` window (3 min–1 h); out-of-range → error + recommended value (`ai.recommendDelayMs`, 5 min) |
| `trigger.defaultTrigger` / `defaultDelayMs` | `delay` / `300000` | What a schedule hit fires with |
| `schedule` | `[]` | `{id, kind: preset|script, preset?, args?, script?, enabled?}` — presets `now/delay/daily/weekly/immediate/waitSeconds/waitAllOrForce`; scripts run as full-trust code (strong warning + audit sha256) |
| `preRestart` | `{mode:'waitAllOrForce', forceAfterMs:30000}` | `immediate` / `waitSeconds(N)` / `waitAllOrForce(-1 = forever)` |
| `postRestart` | `{mode:'resumeAll'}` | `none` / `resumeRequester` / `resumeAll` |
| `restartDelayMs` | `2000` | Grace before the old process exits (ms) |
| `challengeTtlMs` | `300000` | Challenge token lifetime |
| `bootRestoreDelayMs` | `60000` | First wait before progressive restore |
| `restoreStaggerMs` | `5000` | One callback session every N ms afterwards |
| `callbackUnackTimeoutMs` | `1800000` | Receipt timeout (30 min) → one reminder |
| `simulateOnly` | `false` | Drill mode: no real restart (or env `DSH_RESTART_SIMULATE=1`) |
| `notifyPrompt` / `continuePrompt` / `restorePrompt` | `【DSH 重启】…` | Prompts; `{minutes}` / `{cbId}` / `{description}` placeholders |
| `logTailLines` | `300` | Log viewer tail size |

Legacy v0.1.x flat keys (`aiRestartEnabled`, `restartPolicy`, `notifyWaitMs`, …) are accepted and translated automatically.

---

## HTTP API

All routes live under `/plugins/dsh-harness-restart`, guarded to **localhost / private subnets + same-origin**.

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | pid, mode, config, pending, callbacks, supervisors, `simulate`, `lastConfigReloadAt` |
| GET | `/config` | effective config + warnings |
| POST | `/config` | write config (`{patch: {...}}`); strict validation |
| POST | `/restart` | `{trigger:'now'|'delay', delayMs?}` → 202 waiting / 200 accepted / 409 single-flight |
| POST | `/cancel` | cancel a waiting restart |
| GET | `/check` | read-only preflight |
| GET | `/log` | tail of the event log |
| GET | `/log/open` | path of the event log |

Event log: `$DSH_HOME/dsh-harness-restart.log` — records `restart-waiting`, `restart-about-to-exit`, `restart-finalized`, `restart-simulated`, `restart-resumed`, `restore-step`, `callback-error`, `schedule-trigger`, `ai-restart-denied`, … one JSON per line.

---

## Limitations (boundaries)

- **Scope is the dsh process only.** The plugin restarts the dsh web process it runs in; it never restarts, touches, or manages any other system process or service.
- **Crash without a supervisor does not self-heal.** In bare runs the detached helper is only armed during a *requested* restart (`/restart`, tools, schedule). If dsh is killed out of the blue (OOM, `kill -9`, power loss) before the helper exists, nothing relaunches it — run under systemd/container for crash resilience.
- **Post-restart continuation depends on dsh’s own session persistence.** The plugin injects “continue” prompts (resume targets + registered callbacks); the underlying conversation history survives because dsh persists session logs. Sessions that cannot be revived (no live agent, no `sessionController`) are skipped and logged.
- **Only registered/unfinished sessions are resumed.** `resumeAll` covers unfinished root sessions plus sub-agents (via `agents.list()`); other archived/closed sessions are not touched.
- **One pending restart at a time (single-flight).** A concurrent second request returns `409` until the first is cancelled or finalized.
- **AI restrictions are intentional.** AI cannot use `now` by default, `delay` must be within `ai.delayRangeMs`, and each AI restart needs the two-step challenge.
- **Public/tunneled deployments lose probe routes.** Domain authorities are always rejected (`403`); the page auto-reopen and log-open fall back to the printed token URL.
- **Drill mode does not produce a real restart.** `simulateOnly` runs the full event chain and restore flow in-process; nothing exits, and `/status` never shows a new pid.
- **Helper logs live in `/tmp`** (`/tmp/dsh-harness-restart-<stamp>-<port>.{out,err}.log`) and may be cleaned by the OS across reboots; the definitive event trail is `$DSH_HOME/dsh-harness-restart.log`.

---

## Security

See [`SECURITY.md`](SECURITY.md) for the full threat model. Highlights:

- **Route guard**: all mutation and read routes accept only loopback / private IP literals as `Host`, and require same-origin when an `Origin` is present; **domain authorities (incl. DNS-rebinding candidates) are always `403`**, never downgraded.
- **AI tools**: two-step challenge (16-hex token, one-time, 5 min TTL) bound to the first-call arguments; `now` off for AI; out-of-range `delay` rejected with the recommended value.
- **Config writes**: per-key strict validation (`validateConfigV1`); out-of-range values are rejected, never clamped; only the plugin’s own config namespace can be written.
- **Script callbacks run with full trust** in the host process (`new Function`); they are never fetched remotely, are gated behind a strong warning at registration, carry an audit sha256 in the event log, and are individually disablable (`enabled: false`).
- **Data written**: `$DSH_HOME/dsh-resume.json` (session ids, requester, registered callbacks, timestamp) and `$DSH_HOME/dsh-harness-restart.log` (events; may contain session ids and local paths) — both local to the harness user.

---

## Testing (safe, does not touch a running dsh)

The plugin restarts its own process — testing directly on a live instance is what we designed away.

```bash
npm run test          # pure logic + client contract (72 + 11 + 11 assertions, ms)
npm run test:simulate # isolated instance, drill mode: full event chain, zero process deaths (11 checks)
npm run test:e2e      # isolated instance incl. a REAL restart loop (10 checks)
npm run test:chaos    # 9 fault-injection scenarios (kill -9, port squatted by non-dsh,
                      # concurrent 409, helper file deleted, corrupt marker, corrupt config, drills…)
```

Every isolated scenario uses a throwaway `DSH_HOME` under `/tmp`, a dedicated port, and a `trap` that always cleans up. Real-restart loops happen only against those **dummy instances**, never against the dsh you are using.

---

## License

MIT — see [`LICENSE`](LICENSE).

## Security

See [`SECURITY.md`](SECURITY.md).