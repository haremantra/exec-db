# exec-db bootstrap CLI

## What it does

`pnpm bootstrap` walks you through the mechanical parts of the
`docs/pr2-prereqs-runbook.md` and `docs/pr3-prereqs-runbook.md`
runbooks in a single guided terminal session. It auto-generates secrets
(`EMAIL_INTAKE_SECRET`, `GOOGLE_TOKEN_ENC_KEY`, `CRON_SECRET`),
validates credential shapes (Google OAuth, Resend API key), checks DNS
SPF/DKIM propagation via `dig`, tests Postgres connectivity, verifies
and installs the `pgcrypto` and `uuid-ossp` extensions, and then runs
`db:push` + `db:rls` in the correct order. At the end it prints a
one-screen go/no-go status table. Existing `.env` values are preserved
unless `--force` is passed — re-running is safe.

## Prerequisites

- Node 20+ (`node --version` should print `v20.x.x` or higher)
- `pnpm` (`pnpm --version`)
- `dig` on `$PATH` (for DNS checks; comes with `bind-tools` or
  `dnsutils` on Linux, built-in on macOS)
- A running Postgres instance reachable at `DATABASE_URL`
- `pnpm install` already run at the repo root

## Quick start

```bash
pnpm install         # if not already done
pnpm bootstrap
```

The CLI copies `.env.example` → `.env` on first run, then prompts for
each missing value. Secrets are written to `.env` once at the end of
the interactive phase.

## Flags

| Flag | Effect |
|---|---|
| `--force` | Re-prompt for all vars even if already set in `.env` |
| `--seed` | Run `db:seed` after schema push (off by default) |
| `--non-interactive` | Fail rather than prompt; useful for CI dry-runs |
| `--check-only` | Validate current state without writing or running |
| `-h` / `--help` | Print usage and exit |

## What it does NOT replace

The following steps are browser-only and must be done manually before
running this CLI (or immediately after for the Vercel step):

- **GCP project + billing** — `pr2-prereqs-runbook.md` Categories 1–2
- **OAuth consent screen** — `pr2-prereqs-runbook.md` Category 3
- **OAuth client credentials** — `pr2-prereqs-runbook.md` Category 4
  (produces `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`)
- **Service account + JSON key** — `pr2-prereqs-runbook.md` Category 5
- **Audit-log Google Sheet** — `pr2-prereqs-runbook.md` Category 6
- **Resend account + verified domain** — `pr3-prereqs-runbook.md` Cat 1
- **DNS record paste at your registrar** — `pr3-prereqs-runbook.md` Cat 1
- **Vercel project setup + env vars** — `pr3-prereqs-runbook.md` Cat 6

## Troubleshooting

| Symptom | Fix |
|---|---|
| `dig: command not found` | Install `bind-tools` (Linux) or `dnsutils`. On macOS, `dig` is built in. |
| `Cannot connect to DATABASE_URL` | Confirm Postgres is running and the URL is correct (no `~` in path, correct port). |
| `Cannot create extension pgcrypto` | Run as a Postgres superuser: `CREATE EXTENSION IF NOT EXISTS pgcrypto;` |
| `GOOGLE_TOKEN_ENC_KEY` shape warning | The value should be ~44 chars, base64-encoded. Re-generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `RESEND_API_KEY` test fails with 403 | The key lacks Sending access. Recreate it in the Resend dashboard with the correct permission. |
| `.env` accidentally committed | `git rm --cached .env && git commit -m "remove .env"`, then rotate all secrets. |
