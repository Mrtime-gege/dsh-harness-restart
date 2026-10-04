# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a Vulnerability

Please **do not open a public issue** for security problems. Report privately:

- GitHub: open a private advisory via **Security → Report a vulnerability** (preferred)
- Or: open a draft security advisory and reference it in a minimal issue

We aim to acknowledge within 3 business days and ship a fix on the `dev` branch first; the public `release` branch is updated on the next `v0.1.x` tag.

## Threat model (what this plugin is)

`dsh-harness-restart` manages **process lifecycle of the DSH web harness** and exposes management HTTP routes under `/plugins/dsh-harness-restart/*`. Its blast radius is intentionally limited:

- **All routes** (`/status`, `/config`, `/restart`, `/cancel`, `/check`, `/log`, `/log/open`) are guarded by `guardAllowProbe`:
  - only **loopback** (`127.0.0.1`, `localhost`, `::1`) and **private IP literals** (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`) are accepted as `Host`;
  - when an `Origin` header is present, it must itself resolve to a loopback or private address (same-origin style);
  - **domain authorities** (incl. DNS-rebinding candidates like `evil.com` or `*.example.com`) are **always rejected with 403**, and this rejection is never downgraded.
- **AI tool `dsh_restart`** — two-step challenge (16-hex token, one-time, 5 min TTL) bound to the exact first-call arguments; `now` is disabled for AI by default; AI `delay` must sit inside `ai.delayRangeMs` (3 min–1 h) with a recommended value surfaced on out-of-range errors. `dsh_restart_cancel` only affects AI-initiated waits.
- **Config writes** (`POST /config`) are strictly validated per key (`validateConfigV1`); out-of-range values are **rejected, never clamped**; nothing outside the plugin's own config namespace can be written.
- **Script callbacks run with full trust** in the host process (user-provided `new Function`). They are never fetched remotely, are gated behind a strong warning at registration, each carries an audit sha256 in the event log, and can be disabled per entry (`enabled: false`).

## What we do NOT protect against

- A local user who can already execute code as the harness user (they can `kill` the process directly).
- DNS-rebinding against a **public/tunneled** deployment: the plugin intentionally refuses domain authorities, so such deployments lose auto-recovery/log-open (fall back to the printed URL).
- A malicious model that ignores tool guidance: the challenge/token binding reduces accidents, it is not a security boundary against a hostile model.
- Crash daemons in supervisor-less (bare-run) deployments: only on-request restarts (with the detached self-healing helper) work there; an unexpected kill before the helper is armed has no relauncher.

## Data written

- `$DSH_HOME/dsh-resume.json` — resume marker (session ids, requester, registered callbacks, restart timestamp).
- `$DSH_HOME/dsh-harness-restart.log` — structured events + debug lines (may include session ids and local paths).
- `/tmp/dsh-harness-restart-<stamp>-<port>.{out,err}.log` — self-healing helper relaunch logs (failures, retries).

All are local to the harness user only.

## Release hygiene

- `release` branch / npm tarball contain the **plugin body only** (lib, cordis.patch.yml, README.md, README.zh.md, SECURITY.md, LICENSE, NOTICE, package.json).
- Tags follow `v0.1.x`; npm publishing is automated from the `release` branch on tag (see `.github/workflows/publish.yml` — add `NPM_TOKEN` secret or configure npm trusted publishing for this repo).