# PR3 admin prereqs — literal step-by-step runbook

For a non-technical admin (CEO, EA, Chief of Staff). Covers everything
needed to deploy the PR3 feature set: email digests (daily + weekly),
priority-shifter detection, Vercel Cron jobs, and production URL updates.

**Prerequisite**: you have completed `docs/pr2-prereqs-runbook.md` in full.

Estimated total time: **45–60 minutes**.

You will end this runbook with:
- A Resend account with a verified sending domain and an API key.
- SPF, DKIM, and DMARC DNS records published for that domain.
- Your Vercel project updated with all new environment variables.
- OAuth redirect URIs updated for your production Vercel URL.
- All PR3 env vars populated in Vercel (and optionally in local `.env`).

Reference: `docs/pr3-spec.md` streams O, Q (digest infrastructure, priority shifters).

---

## Before you start — collect these

- **Vercel project URL** — the `*.vercel.app` URL or custom domain where the app is deployed.
- **Sending domain** — the domain you want digests to come from (e.g., `digests.example.com` or `exec-db.example.com`). This must be a domain you control (can add DNS records to).

---

## Category 1 — Resend account + API key (15 min)

1. **Create a Resend account.**
   Open <https://resend.com> → click **Sign up** → use the CEO email or a shared team email.

2. **Add your sending domain.**
   1. In the Resend dashboard, go to **Domains** → click **Add domain**.
   2. Enter your sending domain (e.g., `digests.example.com`).
   3. Resend will show you DNS records to add. Continue to step 3.

3. **Publish the DNS records.**
   Log in to your DNS provider (e.g., Cloudflare, Route 53, Google Domains) and add **all three record types** that Resend shows:

   | Record type | Purpose | Example name | Example value |
   |---|---|---|---|
   | `TXT` | SPF — authorizes Resend to send on your behalf | `digests.example.com` or `@` | `v=spf1 include:amazonses.com ~all` *(Resend provides the exact value)* |
   | `CNAME` or `TXT` | DKIM — cryptographic email signature | `resend._domainkey.digests.example.com` | *(Resend provides the exact value)* |
   | `TXT` | DMARC — policy for failed auth | `_dmarc.digests.example.com` | `v=DMARC1; p=none; rua=mailto:your@email.com` |

   > **All three records are required.**  SPF + DKIM prevent spam-folder delivery. DMARC is required by major providers (Gmail, Outlook) for bulk senders as of 2024.

4. **Wait for DNS propagation.**
   DNS changes can take 5–60 minutes. Resend shows a green **Verified** badge once all records are confirmed.

5. **Create a Resend API key.**
   1. Resend dashboard → **API Keys** → click **Create API key**.
   2. **Name**: `exec-db production`.
   3. **Permission**: `Sending access` (not full access).
   4. Click **Add**. **Copy the key immediately** — it is only shown once.
   5. Paste it into your notes as `RESEND_API_KEY`.

---

## Category 2 — Vercel environment variables (15 min)

6. **Open your Vercel project settings.**
   Go to <https://vercel.com> → your project → **Settings** → **Environment Variables**.

7. **Add the following variables.**
   For each variable: click **Add New**, enter the **Name** and **Value**, set **Environment** to `Production` (and optionally `Preview`), then click **Save**.

   | Variable name | Value | Notes |
   |---|---|---|
   | `RESEND_API_KEY` | The key from step 5 | Required. Digest delivery fails without this. |
   | `RESEND_FROM_ADDRESS` | e.g., `exec-db <noreply@digests.example.com>` | Required. Must be a verified Resend sender address. Format: `Display Name <email@domain>`. If omitted, Resend will reject emails from the invalid default. |
   | `NEXT_PUBLIC_APP_URL` | e.g., `https://exec-db.vercel.app` or your custom domain | Required. Used in unsubscribe links in digest emails. Must be the full URL with `https://`. |
   | `EMAIL_INTAKE_SECRET` | A random secret string (see step 8 below) | Required. Authenticates the email-intake webhook endpoint. |
   | `COMPETITOR_DOMAINS` | e.g., `rival.io,competitorco.com` | Optional. Comma-separated list of competitor domains for the priority-shifter detector. Leave blank to disable domain-based detection (phrase-based detection still runs). |
   | `ANTHROPIC_API_KEY` | Your Anthropic API key from <https://console.anthropic.com> | Required for digest ranking (Claude Opus call in the ranker). Get your key from the Anthropic Console under **API Keys**. |
   | `GOOGLE_TOKEN_ENC_KEY` | The same value you set locally in PR2 step 34 | Required. Must match the value used to encrypt tokens stored in the database. |
   | `GOOGLE_CLIENT_ID` | From PR2 step 20 | Required. |
   | `GOOGLE_CLIENT_SECRET` | From PR2 step 20 | Required. |
   | `GOOGLE_OAUTH_REDIRECT_URI` | `https://<your-vercel-domain>/api/auth/google/callback` | Required. See step 9 for updating the GCP OAuth client. |
   | `GOOGLE_SHEETS_AUDIT_ID` | From PR2 step 31 | Required if using Sheet audit logging. |
   | `DATABASE_URL_APP` | Your production Postgres connection string for `app_runtime` role | Required. Format: `postgres://app_runtime:PASSWORD@host:5432/exec_db`. |
   | `DATABASE_URL` | Your production Postgres connection string for the superuser (migration) role | Required for `db:push` / `db:rls` runs. Not needed at Vercel runtime if `DATABASE_URL_APP` is set. |
   | `REDACTION_PUBLIC_DOMAINS` | e.g., `gmail.com,outlook.com,company.com` | Optional. Comma-separated email domains that are NOT masked in LLM prompts. Leave blank to mask all email addresses. |

   > **`GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` does not work on Vercel.**
   > Vercel functions run in ephemeral containers with no local filesystem.
   > The Sheet audit log will silently skip appends on Vercel until this is resolved.
   > **TODO (requires user decision)**: either (a) inline the service-account JSON as a
   > `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_JSON` environment variable and update the code
   > to read it, or (b) use a Vercel integration / secrets manager to mount the file.
   > For now, the Postgres `audit.llm_call` table remains the source of truth and the
   > Sheet append is a best-effort secondary tier.

8. **Generate `EMAIL_INTAKE_SECRET`.**
   Open Terminal (on your local machine) and run:
   ```bash
   openssl rand -hex 32
   ```
   Copy the 64-character hex output as the value for `EMAIL_INTAKE_SECRET`.
   Store it in your password manager — you will need it whenever you configure an email forwarding service to POST to `/api/intake/email`.

---

## Category 3 — Update GCP OAuth client for production (10 min)

9. **Update OAuth redirect URIs in GCP.**
   The PR2 runbook set up `http://localhost:3000` only. For production, you must add the Vercel URL.

   1. Open <https://console.cloud.google.com> → your project → **APIs & Services → Credentials**.
   2. Click the OAuth client `exec-db web (dev)` (or rename it to `exec-db web` now that it covers both).
   3. Under **Authorized JavaScript origins**, click **+ ADD URI** → add your Vercel URL:
      `https://<your-vercel-domain>`
   4. Under **Authorized redirect URIs**, click **+ ADD URI** → add:
      `https://<your-vercel-domain>/api/auth/google/callback`
   5. Click **SAVE**.

   > Existing `localhost:3000` entries can remain for local development.

10. **Update the OAuth consent screen authorized domain (if using a custom domain).**
    APIs & Services → OAuth consent screen → scroll to **App domain** → **Authorized domains**.
    Add your Vercel custom domain (e.g., `exec-db.example.com`) if it differs from your Workspace domain.

---

## Category 4 — Vercel Cron setup (5 min)

11. **Verify Vercel Cron is active.**
    The `apps/web/vercel.json` file defines two crons:
    - Daily digest: `0 14 * * *` (14:00 UTC = 7:00 am Los Angeles PDT)
    - Weekly digest: `0 14 * * 0` (Sundays at same time)

    Vercel Cron is available on **Pro and Enterprise plans** only.

    To verify:
    1. Vercel dashboard → your project → **Cron Jobs** tab.
    2. You should see `GET /api/cron/digest-daily` and `GET /api/cron/digest-weekly` listed.
    3. If the tab is missing or shows an upgrade prompt, upgrade your Vercel plan.

12. **Verify `CRON_SECRET` is set automatically.**
    Vercel automatically injects `CRON_SECRET` into your project environment when you have cron jobs configured on a Pro/Enterprise plan. You do NOT need to generate or set this manually.

    To confirm:
    1. Vercel dashboard → **Settings → Environment Variables**.
    2. Look for `CRON_SECRET` in the list. If it is there (even if the value is hidden), Vercel has set it.
    3. If it is missing, redeploy once from the Vercel dashboard — Vercel injects `CRON_SECRET` on deploy.

    > The cron routes (`/api/cron/digest-daily`, `/api/cron/digest-weekly`) reject all requests
    > that do not present `Authorization: Bearer <CRON_SECRET>`. This prevents anyone from
    > triggering digests manually. Vercel sends this header automatically on scheduled calls.

---

## Category 5 — Verify and test (5 min)

13. **Trigger a test cron call (optional).**
    From the Vercel dashboard → **Cron Jobs** tab → click **Trigger** next to the daily digest cron.
    Check the function logs (Vercel → **Logs**) for a `200 OK` response with `{ "cadence": "daily", ... }`.
    If you see `401 Unauthorized`, `CRON_SECRET` is not set (redeploy).
    If you see `RESEND_API_KEY not set`, add it to environment variables.

14. **Send a test digest manually (optional, developer step).**
    A developer can trigger a single digest send by calling the cron endpoint with the `CRON_SECRET`:
    ```bash
    curl -H "Authorization: Bearer <CRON_SECRET>" \
         https://<your-vercel-domain>/api/cron/digest-daily
    ```
    Replace `<CRON_SECRET>` with the value from the Vercel environment variables page.

15. **Verify Resend delivery.**
    After triggering, log in to the Resend dashboard → **Emails** → confirm the email appears with status `Delivered`.
    If status is `Bounced` or `Failed`, check the `RESEND_FROM_ADDRESS` is a verified sender.

---

## Troubleshooting cheat sheet

| Symptom | Fix |
|---|---|
| Digest cron returns `401 Unauthorized` | `CRON_SECRET` not set in Vercel. Redeploy from Vercel dashboard — it is auto-injected on deploy. |
| `sendEmailViaResend: RESEND_API_KEY env var is required` | Add `RESEND_API_KEY` to Vercel environment variables (step 7). |
| Digest emails go to spam | DNS records incomplete. Verify SPF, DKIM, and DMARC are all published (step 3) and Resend shows the domain as **Verified** (step 4). |
| Unsubscribe links in digest emails return 404 | `NEXT_PUBLIC_APP_URL` is not set or has a typo. Confirm it matches the actual deployed URL (step 7). |
| `Google OAuth not configured` error in production | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or `GOOGLE_OAUTH_REDIRECT_URI` missing from Vercel env vars. |
| OAuth callback fails with `redirect_uri_mismatch` | The production redirect URI was not added to the GCP OAuth client (step 9). |
| `GOOGLE_TOKEN_ENC_KEY env var is not set` | Add `GOOGLE_TOKEN_ENC_KEY` to Vercel env vars (step 7). Must match the value used when tokens were first encrypted locally. |
| Sheet append silently skipped on Vercel | `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` is a local file path and cannot work on Vercel. See the TODO note in step 7. |
| Cron Jobs tab missing in Vercel | Vercel plan does not include Cron. Upgrade to Pro or Enterprise. |
| Priority-shifter domain detection not working | `COMPETITOR_DOMAINS` is not set or is empty. Phrase-based detection still runs regardless. |

---

## What you handed off

- A Resend account with SPF + DKIM + DMARC DNS records verified for your sending domain.
- A Resend API key in Vercel environment variables.
- All PR3 env vars set in Vercel: `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `NEXT_PUBLIC_APP_URL`, `EMAIL_INTAKE_SECRET`, `ANTHROPIC_API_KEY`, `GOOGLE_TOKEN_ENC_KEY`, and optionally `COMPETITOR_DOMAINS`, `REDACTION_PUBLIC_DOMAINS`.
- OAuth redirect URIs updated in GCP for the production Vercel URL.
- Vercel Cron confirmed active (daily + weekly digest schedules).

This covers the admin prerequisite side of PR3 streams O (digest), Q (priority shifters), and the Vercel deployment surface. The developer can now verify end-to-end digest delivery from the deployed app.
