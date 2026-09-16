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

- **Mutation routes** — `POST /restart`, `POST /config`, `POST /cancel`, `POST /log/open` — require full core browser auth (`ctx.connection.requestRejection` must return `undefined`): a valid, unexpired cookie signed by the deployment's persistent secret. Fallback to loopback+same-origin applies only when the connection service is unavailable.
- **Read routes** — `GET /status`, `GET /config`, `GET /log`, `GET /restart` — are credential-free **by design** (the page must recover after a credential rotation), but only reachable from:
  - loopback authorities, or
  - **private IP literals** (10/8, 172.16/12, 192.168/16, 169.254/16, 127/8, `::1`, `localhost`) **with same-origin** when an `Origin` is present.
  - Domain authorities (incl. DNS-rebinding candidates like `evil.com` or `*.example.com`) are **always rejected with 403**, and this rejection is never downgraded.
- **AI tool** `dsh_restart` — two-step challenge (16-char random, one-time, 5 min TTL) bound to the exact first-call `policy`; `now` is disabled for AI; waiting policies enforce a 3-minute floor and a user-visible popup. `dsh_restart_cancel` only affects AI-initiated waits.
- **Config writes** (`POST /config`) are uint-validated per key; nothing outside the `dsh-harness-restart` settings namespace can be written.

## What we do NOT protect against

- A local user who can already execute code as the harness user (they can `kill` the process directly).
- DNS-rebinding against a **public/tunneled** deployment: the plugin intentionally refuses domain authorities, so such deployments lose auto-recovery/log-open (fall back to the printed URL).
- A malicious model that ignores tool guidance: the challenge/policy binding reduces accidents, it is not a security boundary against a hostile model.
- Crash daemons in supervisor-less (bare-run) deployments: only on-request restarts work there; a crash has no relauncher.

## Data written

- `$DSH_HOME/dsh-resume.json` — resume marker (session ids + restart timestamp).
- `$DSH_HOME/dsh-harness-restart.log` — structured events + debug lines (may include session ids and local paths).
Both are local to the harness user only.

## Release hygiene

- `release` branch / npm tarball contain the **plugin body only** (lib, cordis.patch.yml, README.md, LICENSE, package.json).
- Tags follow `v0.1.x`; npm publishing is automated from the `release` branch on tag (see `.github/workflows/publish.yml` — add `NPM_TOKEN` secret or configure npm trusted publishing for this repo).