# PR3 admin prereqs — literal step-by-step runbook

Sister doc to `docs/pr2-prereqs-runbook.md`. Adds every external account
and env var that PR3 introduced (digests, intake, priority shifters,
production deploy). Same audience: a non-technical admin, no terminal
required except the final `.env` step.

Estimated total time: **60–80 minutes** if PR2 prereqs are already done.

You will end this runbook with:
- A Resend account with a verified sender domain and an API key.
- An email-intake forwarder pointed at the production domain.
- A configured competitor-domains list.
- A symmetric encryption key for stored OAuth tokens.
- All PR3 env vars populated in `.env` (local) and Vercel (staging/prod).

Reference: PR3 added these env vars beyond PR2's:
- `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`
- `EMAIL_INTAKE_SECRET`
- `COMPETITOR_DOMAINS`
- `GOOGLE_TOKEN_ENC_KEY`
- `CRON_SECRET` (Vercel sets automatically — no admin action)

`GOOGLE_SHEETS_AUDIT_ID` and `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` are
covered by `docs/pr2-prereqs-runbook.md` Category 5–6 — make sure that
runbook is complete before starting this one.

---

## Before you start

Open a notes app and have these ready:
- **Production domain** (e.g. `app.example.com`) where the deployed app will live.
- **CEO Workspace email** (same as PR2 runbook).
- **List of competitor company domains** the exec wants tracked (e.g. `rival.io,acme-alt.com`).

---

## Category 1 — Resend account + verified domain (20 min)

1. **Create a Resend account.**
   1. Open <https://resend.com/signup>.
   2. Sign up with the CEO Workspace email.
   3. Verify the email link Resend sends.

2. **Add and verify your sender domain.**
   1. In the Resend dashboard, click **Domains → Add Domain**.
   2. Enter your sender domain (e.g. `mail.yourcompany.com`). Subdomains are recommended over the apex domain.
   3. Resend shows DNS records (TXT for SPF, CNAME for DKIM, optional DMARC). **Copy each record into your DNS provider's admin** (Google Domains / Cloudflare / Route 53 / etc.).
   4. Wait 5–15 min for DNS propagation. Resend's UI shows a green "Verified" badge when ready.

3. **Create an API key.**
   1. Resend dashboard → **API Keys → Create API Key**.
   2. Name: `exec-db-prod`. Permissions: **Sending access** (read-only is not enough).
   3. Copy the key (starts with `re_…`) into your notes as `RESEND_API_KEY`.
   4. Also copy your verified sender address (e.g. `digests@mail.yourcompany.com`) as `RESEND_FROM_ADDRESS`.

4. **Test sending** (optional but recommended).
   In Resend dashboard → **Send test email** → put your CEO inbox as the recipient → confirm delivery.

---

## Category 2 — Generate `EMAIL_INTAKE_SECRET` (5 min)

Used to authenticate forwarded emails posting to `/api/intake/email`.

5. **Generate a random secret.** From any Terminal:
   ```bash
   openssl rand -hex 32
   ```
   Copy the 64-character hex string into your notes as `EMAIL_INTAKE_SECRET`.

6. **(Optional, deferred) Wire an email forwarder.**
   The current intake API expects POST JSON, not raw forwarded email. To deliver real emails into it you need an intermediary. Options, ranked by cost:
   - **Pipedream** (free tier 10k events/mo): create a workflow with Email-Trigger source → HTTP-POST destination targeting `https://<your-domain>/api/intake/email` with header `X-Intake-Secret: <value>`.
   - **Cloudflare Worker** with Email Routing: ~$0.50/mo at low volume.
   - **Native Gmail filter forwarding** does NOT work — Gmail can only forward to other email addresses, not HTTP endpoints.
   This step is optional: if you skip it now, the API endpoint exists and tests pass; the exec just won't get auto-created draft contacts from forwarded emails until the intermediary is wired.

---

## Category 3 — Generate `GOOGLE_TOKEN_ENC_KEY` (3 min)

Symmetric key used by `pgp_sym_encrypt` / `pgp_sym_decrypt` in `crm.oauth_token`.

7. **Generate the key.** From Terminal:
   ```bash
   openssl rand -base64 32
   ```
   Copy the 44-char base64 string into your notes as `GOOGLE_TOKEN_ENC_KEY`.

8. **Rotation policy.** Document this somewhere safe — losing this key means every connected Google account must re-authorize. To rotate: generate a new key, run a one-time SQL transaction to re-encrypt all rows, then deploy the new key. (See `docs/access-control.md` for details.)

---

## Category 4 — Decide `COMPETITOR_DOMAINS` (5 min)

Used by Stream Q (priority shifters) to detect when an inbound email mentions a competitor.

9. **List the domains the exec actively monitors.** Comma-separated, no spaces:
   ```
   COMPETITOR_DOMAINS=rival.io,acme-alt.com,competitor3.com
   ```
   Copy into your notes. Empty list is acceptable (phrase-based detection like "we're going with" still runs).

---

## Category 5 — Drop everything into `.env` (5 min)

Done by the dev on their laptop after the runbook above is complete.

10. **Open `.env`.**
    ```bash
    open -e ~/code/exec-db/.env
    ```

11. **Append the new lines** at the bottom:

    ```bash
    # PR3 prereqs
    RESEND_API_KEY=
    RESEND_FROM_ADDRESS=
    EMAIL_INTAKE_SECRET=
    COMPETITOR_DOMAINS=
    GOOGLE_TOKEN_ENC_KEY=
    NEXT_PUBLIC_APP_URL=http://localhost:3000
    # CRON_SECRET is set by Vercel automatically in production; for local dev, set any string.
    CRON_SECRET=local-dev-cron-secret
    ```

12. **Paste the values** from your notes (steps 3, 5, 7, 9).

13. **Save and close** (`⌘+S`, close TextEdit).

14. **Confirm `.env` is gitignored** (same as PR2 runbook step 36):
    ```bash
    cd ~/code/exec-db && git check-ignore -v .env
    ```
    Expect to see a line ending in `.env`. If it prints nothing, **stop** and tell the dev.

---

## Category 6 — Vercel production env vars (10 min)

15. **Open the Vercel project.**
    Sign in to <https://vercel.com>; pick the `exec-db` project. (Create the project first if it doesn't exist — link the GitHub repo.)

16. **Add env vars one at a time.**
    Project → **Settings → Environment Variables**. Add for **Production** + **Preview**:

    | Name | Source | Where used |
    |---|---|---|
    | `DATABASE_URL` | your Postgres connection string (Neon/RDS) | DB writes |
    | `DATABASE_URL_APP` | least-privileged role | DB reads |
    | `ANTHROPIC_API_KEY` | from PR1 | LLM calls |
    | `GOOGLE_CLIENT_ID` | from `pr2-prereqs-runbook.md` step 20 | OAuth |
    | `GOOGLE_CLIENT_SECRET` | from `pr2-prereqs-runbook.md` step 20 | OAuth |
    | `GOOGLE_OAUTH_REDIRECT_URI` | `https://<your-domain>/api/auth/google/callback` | OAuth |
    | `GOOGLE_TOKEN_ENC_KEY` | step 7 above | OAuth-token pgcrypto |
    | `GOOGLE_SHEETS_AUDIT_ID` | from `pr2-prereqs-runbook.md` step 31 | Audit log |
    | `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_BASE64` | **preferred for Vercel** — see step 17 | Audit Sheet (serverless-compatible) |
    | `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` | local `.env` only (Mac dev) | Audit Sheet (local) |
    | `RESEND_API_KEY` | step 3 above | Digest emails |
    | `RESEND_FROM_ADDRESS` | step 3 above | Digest emails |
    | `EMAIL_INTAKE_SECRET` | step 5 above | Email intake auth |
    | `COMPETITOR_DOMAINS` | step 9 above | Priority shifters |
    | `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` | Unsubscribe links |
    | `CRON_SECRET` | Vercel sets automatically — leave blank, Vercel injects it |

17. **Service-account JSON on Vercel — use BASE64.**
    Vercel containers are read-only — filesystem paths don't work. The code now natively supports a `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_BASE64` env var that's decoded at runtime. **Use this on Vercel**:

    ```bash
    base64 -w0 ~/exec-db-secrets/audit-writer.json
    ```
    Paste the output as `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_BASE64` in Vercel → Project → Settings → Environment Variables.

    For local dev you can keep `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH` pointing at the absolute path on your Mac. The code prefers BASE64 if both are set.

18. **Vercel Cron is enabled automatically.**
    The `apps/web/vercel.json` file in the repo declares the daily/weekly schedules. After the first deploy, Vercel reads it and shows the schedules in **Settings → Cron Jobs**. `CRON_SECRET` is auto-injected.

---

## Category 7 — Verify (10 min)

19. **Local typecheck + tests.**
    ```bash
    cd ~/code/exec-db
    pnpm install
    pnpm typecheck
    pnpm test
    ```
    Expect green. **271/271 tests** at PR3 close.

20. **Local dev server.**
    ```bash
    pnpm dev
    ```
    Open <http://localhost:3000/dashboard>. The dashboard renders even without real Google data — sample empty-lane prompts show. The "Do this first" card calls Anthropic and may show a real ranking if you've added test tasks via `pnpm db:seed`.

21. **Resend test from the running app** (optional).
    With the dev server running, hit the unsubscribe endpoint just to confirm routing:
    ```bash
    curl -i "http://localhost:3000/api/digest/unsubscribe?token=test"
    ```
    Expect HTTP 200 (the token won't match anything but the endpoint should not 500).

22. **Production deploy.**
    Push to `main` (already auto-merged via PR3). Vercel builds. Watch the build log for any "missing env var" errors and patch.

23. **First scheduled cron** runs at 7am LA-time the next day. Watch the **Cron Jobs** tab for the run + status.

---

## Category 8 — Optional: opt the CEO into digests (2 min)

24. Once production is live, the CEO signs in and visits `/settings/digest`, ticks "Daily" and/or "Weekly", saves. Their next cron tick will deliver the digest.

---

## Troubleshooting cheat sheet

| Symptom | Fix |
|---|---|
| Resend says "Domain not verified" after 30 min | DNS provider may not have propagated — `dig TXT mail.yourdomain.com` should show the SPF record. Re-paste the TXT record. |
| Vercel build fails on "Missing env var: RESEND_API_KEY" | Check Production scope is enabled on the env var. Re-deploy. |
| `pgp_sym_encrypt` errors at runtime | `GOOGLE_TOKEN_ENC_KEY` not set OR `pgcrypto` extension not enabled. Run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` in your Postgres. |
| Cron runs but nothing happens | Check Vercel Cron logs. Common cause: `CRON_SECRET` mismatch. The cron route validates `Authorization: Bearer ${CRON_SECRET}` — Vercel sets this automatically; do not override. |
| Digest email lands in spam | DMARC + DKIM not yet propagated. Wait 24h after Category 1 step 2 and re-test. |
| Email intake POST returns 401 | `EMAIL_INTAKE_SECRET` mismatch between `.env` and the forwarder's HTTP header. |
| Service-account JSON path doesn't resolve on Vercel | Use option 1 (base64-inline) from step 17 — Vercel doesn't have arbitrary disk paths. |
| `COMPETITOR_DOMAINS` change doesn't take effect | The variable is read at request time but cached by Vercel. Redeploy to invalidate. |

---

---

## Category 9 — Local-dev auth mode (stub) vs. production auth (Clerk) (3 min)

The app supports two auth modes selected by the `AUTH_PROVIDER` env var:

| Value | When to use |
|---|---|
| `stub` | Local development and automated tests. No Clerk keys required. Falls back to a hard-coded dev UUID (`00000000-0000-0000-0000-000000000001`, tier `exec_all`). **Never use in production.** |
| `clerk` | Staging and production. Requires `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. |

**Default recommendation**: keep `.env` set to `AUTH_PROVIDER=stub` for local work.
Flip to `AUTH_PROVIDER=clerk` only when you want to test the real sign-in flow locally
(requires running `pnpm provision-user` first — see Category 10).

---

## Category 10 — Clerk setup (15 min)

Required for staging and production. Skip this category if you are only running locally with `AUTH_PROVIDER=stub`.

25. **Create a Clerk application.**
    1. Open <https://clerk.com> and sign in (or create a free account).
    2. Click **Create application**.
    3. Name: `exec-db`. Enable **Email + Password** and optionally **Google** as sign-in methods.
    4. Click **Create application**.

26. **Copy API keys.**
    In the Clerk dashboard → **API Keys**:
    - Copy **Publishable key** (starts with `pk_…`) → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
    - Copy **Secret key** (starts with `sk_…`) → `CLERK_SECRET_KEY`.

27. **Add allowed URLs.**
    Clerk dashboard → **Domains** → **Add domain** (or click the existing `localhost` domain):
    - For local dev (if you want to test Clerk): `http://localhost:3000`.
    - For production: `https://<your-domain>`.

28. **Configure redirect URLs.**
    Clerk dashboard → **Paths** (or **Customization → Paths** in newer dashboard):
    - Sign-in URL: `/sign-in`
    - Sign-up URL: `/sign-up`
    - After sign-in URL: `/dashboard`
    - After sign-up URL: `/dashboard`
    These match the `NEXT_PUBLIC_CLERK_*` env vars in `.env.example`.

29. **JWT template (optional).**
    If you need custom claims (e.g. to pass tier in the JWT for edge functions),
    go to Clerk dashboard → **JWT Templates → New template**. For the base setup
    this is not required — `getSession()` fetches tier from `crm.user_link` at
    request time.

30. **Provision the first user.**
    After signing in via Clerk for the first time, your Clerk user ID will appear
    in the Clerk dashboard → **Users**. Copy it, then run:
    ```bash
    pnpm provision-user --clerk-id=user_<your-id> --email=<ceo@company.com> --tier=exec_all
    ```
    This inserts a `crm.user_link` row so `getSession()` can resolve the Clerk ID
    to the `employee_dim` UUID.

    To use a specific employee UUID instead of looking up by email:
    ```bash
    pnpm provision-user --clerk-id=user_<your-id> --employee-uuid=00000000-0000-0000-0000-000000000001 --tier=exec_all
    ```

31. **Set Clerk env vars in Vercel.**
    Vercel → Project → Settings → Environment Variables. Add for Production + Preview:
    | Name | Value |
    |---|---|
    | `AUTH_PROVIDER` | `clerk` |
    | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_…` from step 26 |
    | `CLERK_SECRET_KEY` | `sk_…` from step 26 |
    | `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |
    | `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-up` |
    | `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` | `/dashboard` |
    | `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` | `/dashboard` |

32. **Offboarding.**
    To revoke access for a user, delete their `crm.user_link` row:
    ```sql
    DELETE FROM crm.user_link WHERE clerk_user_id = 'user_<id>';
    ```
    This is enough — the user will receive `null` from `getSession()` on their next
    request (Clerk session may still be valid but the app gate returns null → HTTP 401).
    Also disable/delete the user in the Clerk dashboard to prevent token refresh.

---

## What you handed off

After this runbook + `pr2-prereqs-runbook.md`, the production environment has:
- GCP project + OAuth (PR2)
- Audit-log Google Sheet (PR2)
- Resend domain + API key (PR3)
- Email-intake secret (PR3)
- OAuth-token encryption key (PR3)
- Competitor list (PR3)
- Vercel Cron schedules (PR3)

The exec can sign in, connect Google, view the Monday dashboard with real data, generate autodrafts, get morning digests, and use the retrospective.
