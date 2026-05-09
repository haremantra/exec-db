# Deployment Checklist

Cross-check anchor for all environment variables, external services, and infrastructure required to run exec-db in production.

See `docs/pr2-prereqs-runbook.md` and `docs/pr3-prereqs-runbook.md` for step-by-step setup instructions.

---

## Section 1 — Pre-flight checklist

- [ ] All env vars in Section 3 are set in Vercel (or `.env` for local dev)
- [ ] `pgcrypto` and `uuid-ossp` Postgres extensions enabled (see Section 4)
- [ ] `pnpm db:push` run against production database
- [ ] `pnpm db:rls` run against production database (after `db:push`)
- [ ] Resend domain verified (SPF + DKIM + DMARC — see Section 5)
- [ ] GCP OAuth client has production redirect URI registered
- [ ] Vercel Cron Jobs tab shows both digest crons (Pro/Enterprise plan required)

---

## Section 2 — External service accounts required

| Service | Purpose | Where to create | Runbook |
|---|---|---|---|
| Google Cloud Platform (GCP) project | Calendar, Gmail, Sheets, OAuth2 APIs | <https://console.cloud.google.com> | PR2 Category 1 |
| Google OAuth client (web app type) | User Google login | GCP → APIs & Services → Credentials | PR2 Category 4 |
| Google service account | Sheet audit-log writes | GCP → APIs & Services → Credentials | PR2 Category 5 |
| Google Sheet (audit log) | Secondary audit tier | <https://sheets.google.com> | PR2 Category 6 |
| Resend account | Transactional email (digests) | <https://resend.com> | PR3 Category 1 |
| Anthropic API | Claude LLM calls (digest ranking, autodraft) | <https://console.anthropic.com> | PR3 step 7 |
| Vercel (Pro or Enterprise) | Hosting + Cron Jobs | <https://vercel.com> | PR3 Category 4 |
| Postgres database | Application data store | Your provider (e.g., Supabase, Neon, RDS) | — |

---

## Section 3 — Environment variable inventory

All `process.env.X` reads found in the codebase. Marked **REQUIRED** if missing causes a runtime error or security failure. Marked **OPTIONAL** if the code has a graceful fallback.

| Variable | Required? | Default | Set by | Runbook step |
|---|---|---|---|---|
| `DATABASE_URL` | REQUIRED | — | Admin / dev | PR2 (see `.env.example`) |
| `DATABASE_URL_APP` | REQUIRED (prod) | Falls back to `DATABASE_URL` | Admin / dev | PR2 (see `.env.example`) |
| `ANTHROPIC_API_KEY` | REQUIRED | — | Admin | PR3 step 7 |
| `AUTH_PROVIDER` | OPTIONAL | `stub` | Dev | `.env.example` — leave as `stub` until real auth is wired |
| `CLERK_SECRET_KEY` | OPTIONAL | — | Admin | Not yet in use |
| `COMPETITOR_DOMAINS` | OPTIONAL | `""` (domain detection disabled) | Admin | PR3 step 7 |
| `CRON_SECRET` | REQUIRED (prod) | Auto-injected by Vercel | Vercel | PR3 step 12 |
| `EMAIL_INTAKE_SECRET` | REQUIRED | — (returns HTTP 500 if absent) | Admin | PR3 step 7–8 |
| `GOOGLE_CLIENT_ID` | REQUIRED | — | Admin | PR2 step 20, 35 |
| `GOOGLE_CLIENT_SECRET` | REQUIRED | — | Admin | PR2 step 20, 35 |
| `GOOGLE_OAUTH_REDIRECT_URI` | REQUIRED | — | Admin | PR2 step 35; PR3 step 7 |
| `GOOGLE_SHEETS_AUDIT_ID` | OPTIONAL | `""` (Sheet writes skipped) | Admin | PR2 step 31, 35 |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` | LOCAL DEV ONLY | `""` (Sheet writes skipped) | Admin | PR2 step 26, 35 |
| `GOOGLE_TOKEN_ENC_KEY` | REQUIRED | — (throws if absent) | Admin | PR2 step 34; PR3 step 7 |
| `NEXT_PUBLIC_APP_URL` | REQUIRED (prod) | `https://exec-db.local` (breaks unsubscribe links) | Admin | PR3 step 7 |
| `NODE_ENV` | OPTIONAL | Set by Next.js runtime | Runtime | No action needed |
| `NEXT_PUBLIC_APP_NAME` | OPTIONAL | `exec-db` | Dev | `.env.example` |
| `REDACTION_PUBLIC_DOMAINS` | OPTIONAL | `""` (all emails masked) | Admin | PR3 step 7 |
| `RESEND_API_KEY` | REQUIRED (digests) | — (throws if absent) | Admin | PR3 step 5, 7 |
| `RESEND_FROM_ADDRESS` | REQUIRED (prod) | `noreply@exec-db.local` (invalid — Resend rejects) | Admin | PR3 step 7 |
| `WORKOS_API_KEY` | OPTIONAL | — | Admin | Not yet in use |
| `WORKOS_CLIENT_ID` | OPTIONAL | — | Admin | Not yet in use |

---

## Section 4 — Postgres prerequisites

Run these as a superuser (the `DATABASE_URL` user) **before** `db:push`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

**Why**:
- `pgcrypto` — required for `pgp_sym_encrypt` / `pgp_sym_decrypt` (OAuth token storage in `crm.oauth_token`) and `gen_random_bytes()` (unsubscribe token default in `crm.user_pref`).
- `uuid-ossp` — required for `uuid_generate_v4()` used as the primary key default in `crm.oauth_token` and `audit.llm_call`.

**Run order**:
1. Enable extensions (above SQL)
2. `pnpm db:push` — creates all schemas and tables
3. `pnpm db:rls` — creates Postgres roles and applies RLS policies

---

## Section 5 — DNS records required (Resend email)

All three record types must be published and verified in Resend before digest emails will deliver reliably.

| Record type | Name | Purpose | Status |
|---|---|---|---|
| `TXT` (SPF) | `@` or your sending subdomain | Authorizes Resend to send email from your domain | [ ] Verified in Resend |
| `CNAME` or `TXT` (DKIM) | `resend._domainkey.<yourdomain>` | Cryptographic signature for email authenticity | [ ] Verified in Resend |
| `TXT` (DMARC) | `_dmarc.<yourdomain>` | Delivery policy for auth failures | [ ] Published |

Resend shows a ✓ **Verified** badge on the domain when all records are confirmed.

---

## Section 6 — Vercel Cron configuration

Two crons are declared in `apps/web/vercel.json`:

| Path | Schedule | Local time (PDT) | Plan required |
|---|---|---|---|
| `/api/cron/digest-daily` | `0 14 * * *` | 7:00 am Mon–Sun | Vercel Pro or Enterprise |
| `/api/cron/digest-weekly` | `0 14 * * 0` | 7:00 am Sundays | Vercel Pro or Enterprise |

**Note**: In PST (winter, UTC-8), 14:00 UTC = 6:00 am, not 7:00 am. Adjust to `0 15 * * *` / `0 15 * * 0` during PST months if a consistent 7am local time is required year-round.

`CRON_SECRET` is auto-injected by Vercel at deploy time. No manual generation needed.

---

## Section 7 — GCP APIs to enable

| API | Used by | Enable in GCP |
|---|---|---|
| Google Calendar API | `google-calendar.ts` | APIs & Services → Library → Calendar API → ENABLE |
| Gmail API | `google-gmail.ts` | APIs & Services → Library → Gmail API → ENABLE |
| Google Sheets API | `audit-sheet.ts` | APIs & Services → Library → Sheets API → ENABLE |
| Google People API / OAuth2 API | `google.ts` (`userinfo.get()`) | APIs & Services → Library → People API → ENABLE |

---

## Section 8 — OAuth scopes (consent screen)

The following scopes must be on the GCP OAuth consent screen for the app to function:

| Scope | Required by |
|---|---|
| `https://www.googleapis.com/auth/calendar.readonly` | Calendar sync |
| `https://www.googleapis.com/auth/gmail.readonly` | Gmail thread sync |
| `https://www.googleapis.com/auth/gmail.compose` | Draft creation (AD-004: no send) |
| `openid` | OAuth2 identity verification |
| `email` | Fetch user's email via userinfo |
