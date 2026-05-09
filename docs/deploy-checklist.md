# Deploy checklist — exec-db go/no-go

**Audience**: non-technical admin. **Purpose**: single-page status board bridging `pr2-prereqs-runbook.md` and `pr3-prereqs-runbook.md`, plus post-deploy smoke tests.

---

## Section 0 — At a glance

Update this table as each phase completes.

| Phase | Status | Owner | Notes |
|---|---|---|---|
| 0 — Accounts created | ☐ done · ☐ blocked | | GitHub, Anthropic, Resend, Google Workspace |
| 1 — GCP + OAuth | ☐ done · ☐ blocked | | per `pr2-prereqs-runbook.md` cats 1–5 |
| 2 — Audit Sheet | ☐ done · ☐ blocked | | per `pr2-prereqs-runbook.md` cat 6 |
| 3 — PR3 env vars | ☐ done · ☐ blocked | | per `pr3-prereqs-runbook.md` cats 1–5 |
| 4 — Vercel deploy | ☐ done · ☐ blocked | | per `pr3-prereqs-runbook.md` cat 6 |
| 5 — Smoke tests | ☐ done · ☐ blocked | | this doc, section 5 |

---

## Section 1 — Account creation (5 min)

- ☐ **GitHub** — <https://github.com/signup> — repo owner for CI/CD
- ☐ **Anthropic** — <https://console.anthropic.com/> — `ANTHROPIC_API_KEY` with billing enabled
- ☐ **Google Workspace** — <https://workspace.google.com/> — CEO Workspace email; admin access required for GCP + OAuth
- ☐ **Resend** — <https://resend.com/signup> — digest delivery; verified sender domain required

---

## Section 2 — Prerequisite checklist

### PR2 prereqs (`pr2-prereqs-runbook.md`)

- ☐ **Cat 1** (GCP project + billing) — `pr2-prereqs-runbook.md` steps 1–4
- ☐ **Cat 2** (Enable Calendar, Gmail, Sheets APIs) — steps 5–9
- ☐ **Cat 3** (OAuth consent screen — Internal, 3 scopes only) — steps 10–17
- ☐ **Cat 4** (OAuth client credentials) — steps 18–21; produces `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
- ☐ **Cat 5** (Service account `exec-db-audit-writer`) — steps 22–26; produces JSON key + absolute path
- ☐ **Cat 6** (Audit-log Google Sheet) — steps 27–31; produces `GOOGLE_SHEETS_AUDIT_ID`
- ☐ **Cat 7** (Drop values into local `.env`) — steps 32–36
- ☐ **Cat 8** (Verify sheet permissions + consent screen + APIs) — steps 37–40

### PR3 prereqs (`pr3-prereqs-runbook.md`)

- ☐ **Cat 1** (Resend account + verified domain) — steps 1–4; produces `RESEND_API_KEY` + `RESEND_FROM_ADDRESS`
- ☐ **Cat 2** (Generate `EMAIL_INTAKE_SECRET`) — step 5
- ☐ **Cat 3** (Generate `GOOGLE_TOKEN_ENC_KEY`) — step 7
- ☐ **Cat 4** (Decide `COMPETITOR_DOMAINS`) — step 9; empty string is valid
- ☐ **Cat 5** (Drop PR3 values into local `.env`) — steps 10–14
- ☐ **Cat 6** (Vercel env vars + Cron) — steps 15–23

---

## Section 3 — Env-var inventory

Single source of truth. Every production env var in one place.

| Var | Set in | Source | Required for |
|---|---|---|---|
| `DATABASE_URL` | Vercel + local `.env` | Postgres provider (Neon/RDS) | DB writes |
| `DATABASE_URL_APP` | Vercel + local `.env` | Postgres provider (least-privileged role) | DB reads |
| `ANTHROPIC_API_KEY` | Vercel + local `.env` | Anthropic console | LLM calls |
| `GOOGLE_CLIENT_ID` | Vercel + local `.env` | PR2 runbook step 20 | OAuth flow |
| `GOOGLE_CLIENT_SECRET` | Vercel + local `.env` | PR2 runbook step 20 | OAuth flow |
| `GOOGLE_OAUTH_REDIRECT_URI` | Vercel + local `.env` | `https://<domain>/api/auth/google/callback` | OAuth callback |
| `GOOGLE_TOKEN_ENC_KEY` | Vercel + local `.env` | PR3 runbook step 7 (`openssl rand -base64 32`) | pgcrypto token encryption |
| `GOOGLE_SHEETS_AUDIT_ID` | Vercel + local `.env` | PR2 runbook step 31 | Audit Sheet appends |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` | local `.env` only | PR2 runbook step 26 (absolute path) | Audit Sheet auth (local) |
| `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_BASE64` | Vercel | `base64 -w0 audit-writer.json` | Audit Sheet auth (Vercel — see PR3 runbook step 17) |
| `RESEND_API_KEY` | Vercel + local `.env` | PR3 runbook step 3 | Digest email delivery |
| `RESEND_FROM_ADDRESS` | Vercel + local `.env` | PR3 runbook step 3 | Digest sender address |
| `EMAIL_INTAKE_SECRET` | Vercel + local `.env` | PR3 runbook step 5 (`openssl rand -hex 32`) | Email intake auth |
| `COMPETITOR_DOMAINS` | Vercel + local `.env` | PR3 runbook step 9 (comma-separated) | Priority-shifter detection |
| `NEXT_PUBLIC_APP_URL` | Vercel + local `.env` | `https://<your-domain>` | Unsubscribe links, OAuth redirects |
| `CRON_SECRET` | **Vercel auto-sets** — do not override | Vercel | Digest cron auth |
| `REDACTION_PUBLIC_DOMAINS` | Vercel + local `.env` (optional) | Comma-separated allowlist | Redaction filter passthrough |

---

## Section 4 — Deploy

- ☐ Push to `main` (done if all PRs merged)
- ☐ Vercel build green — no missing-env-var errors in build log
- ☐ `pnpm db:push` against prod DB — applies schema migrations
- ☐ `pnpm db:rls` against prod DB — applies RLS policies
- ☐ `pnpm db:seed` against prod DB — optional; seeds dev/demo data

---

## Section 5 — Smoke tests (post-deploy)

Walk through in a real browser. Each step ≤30 s. Use your production URL throughout.

1. ☐ **Sign in** — visit `https://<your-domain>/`. Stub-auth header sets `tier=exec_all`. Lands on home/dashboard page without 500.

2. ☐ **Dashboard renders 5 swimlanes** — visit `/dashboard`. Count exactly 5 swimlane headers: Prospects to follow up · Inbox progress · Admin · Thought leadership · Product roadmap. **Fail if any other count.** _(Invariant #6, PR3 Done §1)_

3. ☐ **"Do this first" card carries counterfactual** — on `/dashboard`, the card lists at least 1 alternative with a deprioritization reason. **Fail if reasons are absent.** _(Invariant #7, PR3 Done §2)_

4. ☐ **Connect Google** — visit `/api/auth/google`. Consent screen shows exactly three scopes: `Calendar.readonly`, `Gmail.readonly`, `Gmail.compose`. **`gmail.send` must NOT appear.** _(Invariant #1, PR2 Done §1)_

5. ☐ **Generate autodraft** — open a contact, click "Generate follow-up". Draft appears in-app with sections Recap / Owners + dates / Next step AND citation footnotes. _(Invariant #4, PR2 Done §4)_

6. ☐ **Audit row written** — after step 5, run: `psql -c "SELECT count(*) FROM audit.llm_call WHERE timestamp_utc > now() - interval '5 minutes'"`. Count must be ≥ 1. **Fail if 0.** _(Invariant #4, PR2 Done §7)_

7. ☐ **Save draft to Gmail Drafts** — click Save on the draft. Visit `mail.google.com` → Drafts. Draft is present. Verify Sent folder has no new entry. _(Invariant #1, PR2 Done §4)_

8. ☐ **Sensitive-flag exclusion** — mark a contact sensitive. (a) Verify it disappears from search results. (b) Sign in with `x-stub-tier: function_lead` header; confirm the contact is absent from all views. _(Invariants #3, #5, PR2 Done §5)_

9. ☐ **Trigger daily digest manually** — `curl -i -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/digest-daily`. Returns `{"users":…,"delivered":…,"skipped":…}` JSON. Opted-in CEO receives Resend email containing Top priorities + Counterfactual aside sections. _(PR3 Done §4)_

10. ☐ **Retrospective view** — visit `/retrospective`. Lists completed-this-week tasks grouped by project. Per-task radio (kept its promise / partially / broke its promise) persists on resubmit. _(PR3 Done §8)_

11. ☐ **CRM export** — visit `/settings/export`, click Download. Receive a zip with JSON tables + `notes/*.md`. Attempt a second download within 24h; expect HTTP 429. _(PR3 Done §9)_

12. ☐ **Audit log row count** — `psql -c "SELECT count(*) FROM audit.llm_call WHERE timestamp_utc > now() - interval '1 hour'"`. Must equal the number of LLM calls made during smoke testing (steps 5, 9). **Fail if 0.** _(Invariant #4)_

---

## Section 6 — Ship decision

> ☐ **GO / SHIP** — all of sections 0–5 are done; build is live for the CEO. Date: ____. Signed off by: ____.
>
> ☐ **NO-GO** — list blocking items here: ________________________

---

## Section 7 — Rollback plan

If a smoke test fails post-deploy: (1) **Revert the last merged PR** via `gh pr revert` or the GitHub UI — Vercel auto-deploys the previous green commit within ~2 min. (2) Database migrations from PR1–3 are additive only — no DB rollback needed; added columns simply go unused. (3) Audit-log rows written during the bad deploy stay in `audit.llm_call` — this is intentional (append-only, `audit.llm_call_no_mutate` trigger). Investigate the failing smoke test before re-attempting deploy.
