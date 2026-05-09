# Runbook Audit — Gap Analysis

**Date**: 2026-05-09  
**Auditor**: Claude Code (autonomous agent)  
**Branch**: `claude/runbook-audit`  
**Runbooks audited**: `docs/pr2-prereqs-runbook.md`, *(pr3-prereqs-runbook.md does not exist — see Finding #1)*  
**Cross-check anchor**: `docs/deploy-checklist.md` *(does not exist — see Finding #2)*

---

## Section 1 — Summary

| Severity | Count |
|---|---|
| **BLOCKER** | 8 |
| **GAP** | 7 |
| **NIT** | 4 |

**Most critical**: The entire PR3 prerequisites runbook is missing (no file at `docs/pr3-prereqs-runbook.md`), leaving five env vars required by PR3 code — `CRON_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `NEXT_PUBLIC_APP_URL`, `EMAIL_INTAKE_SECRET` — with zero admin guidance. Additionally, `GOOGLE_TOKEN_ENC_KEY` is consumed by every OAuth token encrypt/decrypt call but appears nowhere in the PR2 runbook. `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` is a local filesystem path that cannot work on Vercel's read-only filesystem; the runbook has no Vercel-specific guidance. And the `pgcrypto` and `uuid-ossp` Postgres extensions are silently required by schema SQL (used for `pgp_sym_encrypt`, `uuid_generate_v4`) but no runbook step enables them.

---

## Section 2 — Findings Table

| # | Severity | File | Line(s) | Finding | Suggested Fix |
|---|---|---|---|---|---|
| 1 | **BLOCKER** | *(missing file)* | — | `docs/pr3-prereqs-runbook.md` does not exist. The PR3 spec (line 156) explicitly notes "verification pending P1-style admin runbook (not yet written)". Five runtime-required env vars (`CRON_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `NEXT_PUBLIC_APP_URL`, `EMAIL_INTAKE_SECRET`) have no admin setup guidance whatsoever. | Create `docs/pr3-prereqs-runbook.md` (stub created in this PR; see patches). |
| 2 | **BLOCKER** | *(missing file)* | — | `docs/deploy-checklist.md` does not exist. The audit spec calls for it as an env-var cross-check anchor; without it there is no single source of truth for all required env vars across both PRs. | Create `docs/deploy-checklist.md` (stub created in this PR; see patches). |
| 3 | **BLOCKER** | `apps/web/lib/google.ts` | 69–71 | `GOOGLE_TOKEN_ENC_KEY` is required at runtime by `getEncKey()` — it throws if absent. Every OAuth token store/retrieve call fails without it. **The PR2 runbook never mentions this variable** — it is absent from step 33 and from `.env.example`. | Add `GOOGLE_TOKEN_ENC_KEY` to PR2 runbook step 33 and `.env.example`. Patched in this PR. |
| 4 | **BLOCKER** | `apps/web/lib/audit-sheet.ts` | 76 | `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` is a **local filesystem path** (e.g., `/Users/alice/exec-db-secrets/audit-writer.json`). Vercel functions run on ephemeral read-only containers — a local file path will fail silently (the env var will be set but the file will not exist). The runbook (step 26, 34) only describes the local-dev path pattern with no Vercel guidance. | Add a note in the PR3 runbook (or PR2 step 26) explaining that for Vercel deployment, the service-account JSON **content** must be inlined as a single-line env var (`GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_JSON`) and the code updated to read it. Ambiguous — requires user decision on whether to inline JSON vs. use a secrets service. Patched with a TODO note; code change is out of scope. |
| 5 | **BLOCKER** | `packages/db/src/schema/crm.ts` | 256 | `crm.oauth_token.id` uses `uuid_generate_v4()` as its DB default. `audit.llm_call.id` also uses `uuid_generate_v4()`. Both require the **`uuid-ossp`** Postgres extension. Neither runbook tells the admin to run `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`. Without it, any insert to these tables fails with `ERROR: function uuid_generate_v4() does not exist`. | Add `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";` to runbook DB-setup steps. Patched in PR2 runbook step for database initialisation. |
| 6 | **BLOCKER** | `apps/web/lib/google.ts` | 126, 173 | `pgp_sym_encrypt` / `pgp_sym_decrypt` require the **`pgcrypto`** Postgres extension. Every OAuth token read/write fails without it. Neither runbook mentions enabling it. | Add `CREATE EXTENSION IF NOT EXISTS pgcrypto;` instruction. Patched in PR2 runbook. |
| 7 | **BLOCKER** | `apps/web/app/api/cron/digest-daily/route.ts` | 28–31 | `CRON_SECRET` is required to authenticate Vercel Cron calls; the cron handler rejects all requests without it. The PR3 code exists but no runbook explains that Vercel auto-injects `CRON_SECRET` only when a cron is defined **and** the project is on a Vercel Pro or Enterprise plan, or tells the admin how to verify it is set. | Explain in PR3 runbook step how Vercel sets `CRON_SECRET` automatically, and how to confirm it in the Vercel dashboard. Patched in the new PR3 runbook. |
| 8 | **BLOCKER** | `apps/web/lib/email-resend.ts` | 37–39 | `RESEND_API_KEY` throws if absent; digest delivery is completely broken without it. No runbook exists for PR3, so there is zero guidance for creating a Resend account, verifying a sending domain, or obtaining the key. | Covered in the new PR3 runbook (see patches). |
| 9 | **GAP** | `apps/web/lib/auth.ts` | 25 | `AUTH_PROVIDER` defaults to `"stub"` but throws an error for any other value not yet wired. `.env.example` documents it, but neither runbook explains what value to use in production or how to wire WorkOS/Clerk. The code comment says "swap in Phase 1" but no runbook step exists. | TODO: requires user decision on which auth provider to use for production. Noted in audit only. |
| 10 | **GAP** | `apps/web/lib/email-resend.ts` | 45 | `RESEND_FROM_ADDRESS` is optional (defaults to `noreply@exec-db.local`) but the default is an invalid domain that Resend will reject. The admin must set a verified sender address. No runbook covers this. | Add `RESEND_FROM_ADDRESS` to the PR3 runbook env-var step. Patched. |
| 11 | **GAP** | `apps/web/lib/digest-body.ts` | 249 | `NEXT_PUBLIC_APP_URL` is used to build unsubscribe links. If unset, it falls back to `https://exec-db.local` — links in real digest emails will be broken. No runbook instructs the admin to set this for production. | Add `NEXT_PUBLIC_APP_URL` to the PR3 runbook. Patched. |
| 12 | **GAP** | `apps/web/lib/priority-shifters.ts` | 210 | `COMPETITOR_DOMAINS` is an optional env var (comma-separated list). Without it, domain-based competitor detection is silently disabled. The code is functional but administrators may not know to populate it. | Add `COMPETITOR_DOMAINS` to PR3 runbook as an optional env var with an example. Patched. |
| 13 | **GAP** | `apps/web/app/api/intake/email/route.ts` | 122 | `EMAIL_INTAKE_SECRET` is required; the server returns HTTP 500 if absent. No runbook covers creating or setting this secret. | Add `EMAIL_INTAKE_SECRET` to PR3 runbook. Patched. |
| 14 | **GAP** | `apps/web/app/api/auth/google/route.ts` | 17–21 | OAuth scopes requested include `openid` and `email` (lines 20–21) in addition to the three scopes listed in PR2 runbook step 15. The `openid` scope triggers the OpenID Connect flow (fetches id_token); `email` is needed for `userinfo.get()` (see `google.ts` line 104). The consent screen step (step 15) says "Tick exactly these **three**" but the code requests five. | Add `openid` and `email` to the consent screen step 15 scope list. Patched in PR2 runbook. |
| 15 | **GAP** | `packages/db/src/schema/crm.ts` | 335–354 | `crm.user_pref.unsubscribe_token` defaults via `gen_random_bytes(32)` which also requires **`pgcrypto`** (already covered by finding #6). The migration comment in the schema file (line 325) documents this, but neither runbook tells the admin that `db:push` alone is not sufficient — `CREATE EXTENSION IF NOT EXISTS pgcrypto` must be run first. Covered by finding #6 patch. | Covered by finding #6. |
| 16 | **GAP** | `docs/pr2-prereqs-runbook.md` | Step 15 (OAuth scopes) | The consent screen step 15 says to add `calendar.readonly`, `gmail.readonly`, and `gmail.compose` — but the PR2 runbook step 19 says to add `http://localhost:3000` for Authorized JavaScript Origins. The runbook step 19.4 does not mention adding the production/staging URL in the same step, only mentioning it parenthetically: "(Add your staging/prod URL in PR3.)" There is no PR3 runbook step that follows up. | Add a step in PR3 runbook to update the OAuth client's Authorized JavaScript Origins and Authorized Redirect URIs with the Vercel deployment URL. Patched. |
| 17 | **NIT** | `docs/pr2-prereqs-runbook.md` | Step 28 | The audit-log Sheet schema in step 28 lists 9 columns (A1–I1) but `audit-sheet.ts` writes 11 columns (`SHEET_COLUMNS` array, lines 38–50: adds `redactions_applied` and `outcome` after `response_hash`). The Sheet will accumulate data correctly (the code auto-writes a header on first append) but the manual-setup step will create a header that doesn't match. | Update step 28 to list all 11 columns in order. Patched. |
| 18 | **NIT** | `docs/pr2-prereqs-runbook.md` | Step 33 | `DATABASE_URL` and `DATABASE_URL_APP` are used throughout the codebase but are not mentioned in the PR2 env-var step 33. They appear in `.env.example` (lines 2–3) with placeholder values, but the runbook step 33 "Append the new lines" only covers Google vars. | Add a note pointing admin to `.env.example` for DB connection strings. NIT only — dev presumably handles DB setup separately. |
| 19 | **NIT** | `apps/web/lib/audit-sheet.ts` | 4 | Code comment says "`pnpm --filter @exec-db/web add googleapis`" must be run before production use, but `googleapis` is already listed in `apps/web/package.json` dependencies (line 17). The dynamic import guard is therefore unnecessary in production. | NIT — confusing comment. No runbook change needed; code comment could be cleaned up in a future PR. |
| 20 | **NIT** | `docs/pr2-prereqs-runbook.md` | Step 26.4 | Step 26 instructs the admin to store the service-account key at `~/exec-db-secrets/audit-writer.json` using Terminal. The "no terminal needed except the last category" promise in the intro (line 4) is contradicted here. | Minor inconsistency. Could clarify in the intro that Category 5 step 26 is the one exception. Not critical. |

---

## Section 3 — Env-var Cross-check Table

Every `process.env.X` read in the codebase, mapped to where a runbook covers it.

| Env Var | File(s) that read it | PR2 Runbook Step | PR3 Runbook Step | `.env.example` | Status |
|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropic.ts:71,174` | — | — | Yes (line 13) | **MISSING from both runbooks** — `.env.example` only. GAP: PR3 runbook should cover creating Anthropic API key. |
| `AUTH_PROVIDER` | `auth.ts:25` | — | — | Yes (line 7) | GAP: no runbook guidance for production auth. Stub-only for now. |
| `COMPETITOR_DOMAINS` | `priority-shifters.ts:210` | — | — | No | **MISSING**. GAP: optional, but should be documented. Patched in PR3 runbook. |
| `CRON_SECRET` | `cron/digest-daily/route.ts:28`, `cron/digest-weekly/route.ts:28` | — | — | No | **MISSING**. BLOCKER: Vercel auto-injects but admin needs guidance. Patched in PR3 runbook. |
| `DATABASE_URL` | `db.ts:7`, `google.ts:75`, `google-calendar.ts:134`, `google-gmail.ts:280`, `seed.ts:52` | — | — | Yes (line 2) | NIT: not in any runbook step; only in `.env.example`. |
| `DATABASE_URL_APP` | `db.ts:7`, `google.ts:75`, `google-calendar.ts:134`, `google-gmail.ts:280` | — | — | Yes (line 3) | NIT: not in any runbook step; only in `.env.example`. |
| `EMAIL_INTAKE_SECRET` | `intake/email/route.ts:122` | — | — | No | **MISSING**. BLOCKER: intake endpoint returns HTTP 500 without it. Patched in PR3 runbook. |
| `GOOGLE_CLIENT_ID` | `google/route.ts:25`, `callback/route.ts:53`, `google.ts:199` | Step 20, 33 | — | No | COVERED in PR2. |
| `GOOGLE_CLIENT_SECRET` | `callback/route.ts:54`, `google.ts:200` | Step 20, 33 | — | No | COVERED in PR2. |
| `GOOGLE_OAUTH_REDIRECT_URI` | `google/route.ts:26`, `callback/route.ts:55`, `google.ts:201` | Step 33 | — | No | COVERED in PR2. |
| `GOOGLE_SHEETS_AUDIT_ID` | `audit-sheet.ts:75` | Step 31, 33 | — | No | COVERED in PR2. |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` | `audit-sheet.ts:76` | Step 26, 33 | — | No | BLOCKER for Vercel (filesystem path). TODO: requires user decision on Vercel deployment strategy. |
| `GOOGLE_TOKEN_ENC_KEY` | `google.ts:69` | **MISSING** | — | No | **MISSING**. BLOCKER. Patched in PR2 runbook step 33. |
| `NEXT_PUBLIC_APP_URL` | `digest-body.ts:249` | — | — | No | **MISSING**. GAP: fallback to `exec-db.local` breaks unsubscribe links. Patched in PR3 runbook. |
| `NODE_ENV` | `auth.ts:39`, `google/route.ts:44`, `middleware.ts:16` | — | — | Yes (line 16) | Set by runtime (Next.js). No admin action needed. |
| `REDACTION_PUBLIC_DOMAINS` | `redaction.ts:86` | — | — | No | GAP: optional but affects all LLM calls (email masking). Not patched (requires user decision on which domains to allow). |
| `RESEND_API_KEY` | `email-resend.ts:37` | — | — | No | **MISSING**. BLOCKER: digest delivery fails. Patched in PR3 runbook. |
| `RESEND_FROM_ADDRESS` | `email-resend.ts:45` | — | — | No | **MISSING**. GAP: defaults to invalid domain. Patched in PR3 runbook. |

---

## Section 4 — GCP API Coverage

| GCP API | Code Surface | PR2 Runbook Step | Status |
|---|---|---|---|
| Google Calendar API | `google-calendar.ts` — `google.calendar({ version: "v3" })` | Step 6 | COVERED |
| Gmail API | `google-gmail.ts` — `google.gmail({ version: "v1" })` | Step 7 | COVERED |
| Google Sheets API | `audit-sheet.ts` — `google.sheets({ version: "v4" })` | Step 8 | COVERED |
| Google OAuth2 / userinfo | `google.ts:104` — `google.oauth2({ version: "v2" })` | Not mentioned | **GAP**: The userinfo API (`oauth2.userinfo.get()`) is called during the OAuth callback to fetch the user's email. This is part of the standard OAuth2 API but is not explicitly listed in step 9's verification checklist. The `openid` and `email` scopes (used for userinfo) are also missing from step 15. Patched via finding #14 (scope fix). |

---

## Section 5 — OAuth Scope Coverage

| Scope Literal | File | Runbook Step 15 | Status |
|---|---|---|---|
| `https://www.googleapis.com/auth/calendar.readonly` | `auth/google/route.ts:17` | Listed | COVERED |
| `https://www.googleapis.com/auth/gmail.readonly` | `auth/google/route.ts:18` | Listed | COVERED |
| `https://www.googleapis.com/auth/gmail.compose` | `auth/google/route.ts:19` | Listed | COVERED |
| `openid` | `auth/google/route.ts:20` | **Missing** | **GAP**: Required for id_token; the `userinfo.get()` call in `google.ts:104` needs this. Must be added to consent screen scope list. Patched. |
| `email` | `auth/google/route.ts:21` | **Missing** | **GAP**: Required to receive the user's email in the id_token and from userinfo. Must be added to consent screen scope list. Patched. |
| `https://www.googleapis.com/auth/spreadsheets` | `audit-sheet.ts:107` | Not in consent screen step | Note: This scope is used by the **service account** (not the user OAuth flow), so it does NOT need to appear on the consent screen. The service account is granted sheet access directly (step 30). COVERED correctly. |

---

## Section 6 — Postgres Extension / Role / Schema Coverage

### Extensions

| Extension | Required By | Runbook Coverage | Status |
|---|---|---|---|
| `pgcrypto` | `pgp_sym_encrypt` / `pgp_sym_decrypt` in `google.ts:126,173`; `gen_random_bytes()` in `crm.user_pref` default | **Missing from both runbooks** | **BLOCKER**. Patched in PR2 runbook. |
| `uuid-ossp` | `uuid_generate_v4()` in `crm.oauth_token.id` default and `audit.llm_call.id` default | **Missing from both runbooks** | **BLOCKER**. Patched in PR2 runbook. |

### Postgres Roles

| Role | Created by | Runbook Coverage | Status |
|---|---|---|---|
| `app_runtime` (LOGIN) | `roles.sql:8` | Not explicitly mentioned — `db:rls` script applies it | GAP: The runbook mentions `pnpm db:rls` in the dev setup (PR2 spec) but the PR2-prereqs runbook does not tell the admin to run it. The role creation is in `roles.sql` and is applied by `pnpm db:rls`. |
| `app_exec` (NOLOGIN) | `roles.sql:11` | Same as above | GAP: same. |
| `app_function_lead` (NOLOGIN) | `roles.sql:14` | Same | GAP: same. |
| `app_manager` (NOLOGIN) | `roles.sql:17` | Same | GAP: same. |
| `app_employee` (NOLOGIN) | `roles.sql:20` | Same | GAP: same. |
| `app_assistant` (NOLOGIN) | `roles.sql:24` | Same | GAP: same. |

**Note**: All roles are created idempotently by `pnpm db:rls`. The dev/admin needs only to run that command with a superuser `DATABASE_URL`. This command is mentioned in the root `package.json` `db:rls` script but is not called out in the PR2 runbook for the admin to run. Added to PR2 runbook patch.

### Postgres Schemas

| Schema | Defined by | Created by | Runbook Coverage | Status |
|---|---|---|---|
| `core` | `pgSchema("core")` in `core.ts:12` | `drizzle-kit push` (`db:push`) | Not explicitly mentioned | Note: `drizzle-kit push` creates schemas automatically. COVERED by implication if admin runs `db:push`. |
| `crm` | `pgSchema("crm")` in `crm.ts:30` | `db:push` | Same | COVERED by implication. |
| `pm` | `pgSchema("pm")` in `pm.ts:17` | `db:push` | Same | COVERED by implication. |
| `hr` | Schema files | `db:push` | Same | COVERED by implication. |
| `fin` | Schema files | `db:push` | Same | COVERED by implication. |
| `audit` | `pgSchema("audit")` in `audit.ts:14` | `db:push` | Same | COVERED by implication. |
| `comp` | Schema files | `db:push` | Same | COVERED by implication. |
| `legal` | Schema files | `db:push` | Same | COVERED by implication. |
| `ops` | Schema files | `db:push` | Same | COVERED by implication. |
| `app` | Helper functions in `policies.sql` | `db:rls` script | Not mentioned | GAP: `app` schema functions (`app.current_user_id()`, `app.current_tier()`, `app.current_function()`, `app.is_under_current_manager()`, `app.assert_min_cell_size()`) are created by `db:rls`, which must be run after `db:push`. Order matters: runbook should say "`db:push` then `db:rls`". Patched. |

### Ambiguous / TODO items requiring user decision

1. **`GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` on Vercel** (Finding #4): The code reads a local file. On Vercel this must become inline JSON. The fix requires both a code change (reading `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_JSON` instead of a file) and an env-var change. Left as a TODO note in the PR3 runbook because the code change is out of scope for this audit.

2. **`REDACTION_PUBLIC_DOMAINS`** (Section 3): Leaving it unset causes all email addresses in LLM prompts to be masked, which may be correct or may break prompt quality. The admin needs to decide which public domains (e.g., press release domains) are safe to pass through. No patch applied.

3. **`AUTH_PROVIDER` for production** (Finding #9): The code throws if set to anything other than `"stub"`. Moving to WorkOS or Clerk requires code changes beyond the runbook. Left as TODO.

4. **Vercel plan requirement for cron jobs** (Finding #7 partially): Vercel Cron is only available on Pro and Enterprise plans. The PR3 runbook notes this but the admin needs to confirm their plan.
