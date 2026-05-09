# PR2 admin prereqs — literal step-by-step runbook

For a non-technical admin (CEO, EA, Chief of Staff). No terminal needed
except the **last category** (drop credentials into `.env`). Everything
else is clicks in browser tabs.

Estimated total time: **75–90 minutes**, mostly waiting for screens to
load. Have a password manager open and a notes app to paste the values
you'll collect along the way.

You will end this runbook with:
- A Google Cloud project with Calendar + Gmail APIs turned on.
- An OAuth consent screen configured for your Workspace.
- OAuth client credentials (`client_id` + `client_secret`).
- A service account that can write to one Google Sheet.
- A Google Sheet named `exec-db prompt audit log YYYY-MM` ready for daily appends.
- `.env` populated so the dev can start writing PR2 code.

Reference: `docs/pr2-spec.md` prereqs P1–P4. This runbook expands each
prereq into atomic steps.

---

## Before you start — collect three things

Open a notes app and paste in the values for these. You'll need them
later.

- **Workspace primary domain** (e.g. `example.com`). The email domain
  the CEO and team sign in with.
- **CEO Google Workspace email** (the account that owns the GCP project).
- **App display name** (e.g. `exec-db`). This shows on the OAuth
  consent screen. Pick something execs recognize.

---

## Category 1 — GCP project + billing (15 min)

1. **Sign in to Google Cloud.** Open <https://console.cloud.google.com/> in a browser logged in with the **CEO Workspace email** from above.

2. **Create a new project.**
   1. Click the project picker at the top (left of the search bar).
   2. Click **NEW PROJECT** (top right of the dialog).
   3. **Project name**: `exec-db`. Leave the auto-generated **Project ID** as-is — Google appends a random suffix (e.g. `exec-db-471203`) so it stays globally unique. If you want a custom ID, use something distinctive like `exec-db-<your-company>` to avoid collisions; do not assume `exec-db-prod` is available.
   4. **Organization**: select your Workspace organization (matches your domain).
   5. Click **CREATE**. Wait ~30 s for the project to provision.
   6. **Copy the Project ID** into your notes (you'll see it in the picker after the project is created — it ends with a random suffix like `exec-db-471203`).

3. **Switch to the new project.**
   At the top, click the project picker → select **exec-db**. Confirm the project name shows in the top bar.

4. **Link a billing account.**
   1. Left nav (hamburger top-left) → **Billing**.
   2. If a billing account is already linked, you're done — skip to Category 2.
   3. If not, click **LINK A BILLING ACCOUNT** → pick an existing account, or **CREATE BILLING ACCOUNT** → enter card details. Both Calendar and Gmail APIs are free at our usage volume; this is just to satisfy the GCP requirement.

---

## Category 2 — Enable APIs (5 min)

5. **Open the API library.**
   Left nav → **APIs & Services → Library**.

6. **Enable the Google Calendar API.**
   1. Search box: type `Google Calendar API`.
   2. Click the result.
   3. Click **ENABLE**. Wait ~10 s.

7. **Enable the Gmail API.**
   1. Click **← Library** at the top to go back.
   2. Search: `Gmail API`.
   3. Click → **ENABLE**.

8. **Enable the Google Sheets API.**
   Required for the audit-log Sheet writer in P4 (Category 6).
   1. Back to Library.
   2. Search: `Google Sheets API`.
   3. **ENABLE**.

8a. **Enable the Google People API (userinfo).**
    The OAuth callback fetches the user's email via the OAuth2 userinfo endpoint.
    1. Back to Library.
    2. Search: `Google People API`.
    3. **ENABLE**.
    *(Alternatively: search `OAuth2 API` — the userinfo endpoint is part of the Google OAuth2 API.
    If you see both "Google People API" and "Google OAuth2 API" in the library, enable both.
    The app will work without this step if your account is already in your Workspace directory, but enabling
    it prevents permission errors in strict Workspace environments.)*

9. **Verify all four are on.**
   Left nav → **APIs & Services → Enabled APIs & services**. You should see *Google Calendar API*, *Gmail API*, *Google Sheets API*, and *Google People API* (or *Google OAuth2 API*) listed.

---

## Category 3 — OAuth consent screen (15 min)

10. **Open the consent screen config.**
    Left nav → **APIs & Services → OAuth consent screen**.

11. **Pick the user type.**
    Choose **Internal** (only users inside your Workspace org can sign in).
    - If **Internal** is greyed out, your CEO account isn't a Workspace admin — stop and have an admin (Workspace super-admin) finish this step.
    Click **CREATE**.

12. **App information.**
    - **App name**: `exec-db` (the App display name from your notes).
    - **User support email**: the CEO Workspace email.
    - **App logo**: skip for now.

13. **App domain.**
    - **Application home page**: leave blank (we'll fix in PR3 when there's a public URL).
    - **Application privacy policy / terms of service**: leave blank.
    - **Authorized domains**: click **+ ADD DOMAIN** → enter your Workspace primary domain (e.g. `example.com`). Press Enter.

14. **Developer contact information.**
    - Email: the CEO Workspace email.
    Click **SAVE AND CONTINUE**.

15. **Scopes.**
    Click **ADD OR REMOVE SCOPES**. Tick exactly these five:
    - `https://www.googleapis.com/auth/calendar.readonly` — *See and download your calendars*
    - `https://www.googleapis.com/auth/gmail.readonly` — *Read all resources and their metadata*
    - `https://www.googleapis.com/auth/gmail.compose` — *Manage drafts and send emails* (we use it for **drafts only** — see PR2 spec invariant #1)
    - `openid` — *Required for the OpenID Connect flow; lets the callback verify the user's identity*
    - `email` — *Required to read the user's Google account email via the userinfo endpoint*

    **Do NOT add** `gmail.send`, `gmail.modify`, or any write-send scopes. The spec forbids `gmail.send` everywhere.

    > **Why `openid` and `email`?** The OAuth callback (`/api/auth/google/callback`) calls
    > `google.oauth2().userinfo.get()` to retrieve the authenticated user's email address so
    > the app can link the Google account to the correct internal user record.  Both `openid`
    > and `email` are required for that call to succeed.

    Click **UPDATE** → **SAVE AND CONTINUE**.

16. **Test users.** Internal-only apps don't need test users. Click **SAVE AND CONTINUE**.

17. **Summary.** Click **BACK TO DASHBOARD**. The consent screen is live for everyone in your Workspace.

---

## Category 4 — OAuth client credentials (10 min)

18. **Open Credentials.**
    Left nav → **APIs & Services → Credentials**.

19. **Create the OAuth client.**
    1. Click **+ CREATE CREDENTIALS** → **OAuth client ID**.
    2. **Application type**: `Web application`.
    3. **Name**: `exec-db web (dev)`.
    4. **Authorized JavaScript origins**: click **+ ADD URI** → `http://localhost:3000`. (Add your staging/prod URL in PR3.)
    5. **Authorized redirect URIs**: click **+ ADD URI** → `http://localhost:3000/api/auth/google/callback`.
    6. Click **CREATE**.

20. **Copy the credentials.**
    A modal appears with **Client ID** and **Client secret**. **Copy both into your notes immediately.** You can re-open this from the Credentials page later, but copy now to avoid one round-trip.

    - `GOOGLE_CLIENT_ID` = the long `*.apps.googleusercontent.com` value.
    - `GOOGLE_CLIENT_SECRET` = the `GOCSPX-…` value.

21. Click **OK** to close the modal.

---

## Category 5 — Service account for the audit Sheet (10 min)

22. **Create the service account.**
    1. Left nav → **APIs & Services → Credentials**.
    2. Click **+ CREATE CREDENTIALS** → **Service account**.
    3. **Service account name**: `exec-db-audit-writer`.
    4. **Service account ID**: leave the auto-generated value.
    5. **Description**: `Appends rows to the daily prompt audit Sheet.`
    6. Click **CREATE AND CONTINUE**.

23. **Grant access (skip).**
    Don't grant any project roles. Click **CONTINUE**.

24. **Grant users access (skip).**
    Click **DONE**.

25. **Copy the service-account email.**
    On the Credentials page, under **Service Accounts**, find `exec-db-audit-writer@<project-id>.iam.gserviceaccount.com`. **Copy this email into your notes** — you'll share the Sheet with it in Category 6.

26. **Create a JSON key.**
    1. Click the service-account email to open it.
    2. Tab **KEYS** → **ADD KEY → Create new key**.
    3. **Key type**: `JSON`. Click **CREATE**.
    4. A `.json` file downloads. From Terminal, move it to a fixed location:
       ```bash
       mkdir -p ~/exec-db-secrets
       mv ~/Downloads/<downloaded-name>.json ~/exec-db-secrets/audit-writer.json
       ```
       Do NOT commit this file to git.
    5. **Capture the absolute path** for `.env`. The app does not expand `~`, so use the full `/Users/<your-mac-username>/exec-db-secrets/audit-writer.json`. From Terminal:
       ```bash
       echo "$HOME/exec-db-secrets/audit-writer.json"
       ```
       Paste the printed line into your notes verbatim — it's already absolute and `~`-free.

---

## Category 6 — Create the audit-log Google Sheet (10 min)

27. **Create the Sheet.**
    1. Open <https://sheets.google.com> in the same Workspace account.
    2. Click **+ Blank** to make a new sheet.
    3. **Rename** the file (top-left) to `exec-db prompt audit log YYYY-MM` (current year-month). The sheet rotates monthly later; this is the first one.

28. **Add the header row.**
    Type the 11 column names directly into cells **A1 through K1**, one name per cell, in this order:

    | A1 | B1 | C1 | D1 | E1 | F1 | G1 | H1 | I1 | J1 | K1 |
    |---|---|---|---|---|---|---|---|---|---|---|
    | `timestamp_utc` | `contact_id` | `model` | `prompt_class` | `redacted_input_hash` | `response_hash` | `redactions_applied` | `input_tokens` | `output_tokens` | `cost_usd` | `outcome` |

    > **Note**: The code writes 11 columns (added `redactions_applied` and `outcome` since the initial spec).
    > If you see a different column count in code, the code is authoritative — the header is also written
    > automatically on the first append if cell A1 is empty.

    (If you prefer to paste rather than type: select cell A1, then paste the line with real tab characters between column names. Most browsers preserve tabs from a code editor; pasting from a rendered doc may not, so typing is safer.)

29. **Freeze the header.** View → Freeze → 1 row.

30. **Share the Sheet with the service account.**
    1. Click **Share** (top-right).
    2. Paste the service-account email from step 25.
    3. **Permission**: `Editor`.
    4. **Untick** *Notify people* (the address can't receive email).
    5. Click **Share** → confirm.

31. **Copy the Sheet ID.**
    The URL looks like `https://docs.google.com/spreadsheets/d/<LONG-ID>/edit`. Copy `<LONG-ID>` into your notes as `GOOGLE_SHEETS_AUDIT_ID`.

---

## Category 7 — Drop everything into `.env` (5 min)

This is the only step that touches the dev machine. Have whoever runs the dev server (likely the CEO on macOS, per `BUILD-MACOS.md`) do these steps.

32. **Open `.env`.**
    ```bash
    open -e ~/code/exec-db/.env
    ```

33. **Append the new lines** at the bottom:

    ```bash
    # Google integration (PR2 prereqs P1–P4)
    GOOGLE_CLIENT_ID=
    GOOGLE_CLIENT_SECRET=
    GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/google/callback

    # Token encryption key — REQUIRED. Used by pgp_sym_encrypt/pgp_sym_decrypt
    # to store OAuth access/refresh tokens in the database.
    # Generate a strong random value (at least 32 characters):
    #   openssl rand -hex 32
    # NEVER commit this value to git. Rotate it by running db:rls again after changing.
    GOOGLE_TOKEN_ENC_KEY=

    # Audit-log Sheet (P4)
    GOOGLE_SHEETS_AUDIT_ID=
    # Use the absolute path from step 26.5 (no leading ~ — it does not expand from .env)
    # IMPORTANT: This path is for local development only.
    # For Vercel deployment, see docs/pr3-prereqs-runbook.md — the file-path approach
    # does not work on Vercel's read-only containers. A different strategy is required.
    GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH=
    ```

34. **Generate and set `GOOGLE_TOKEN_ENC_KEY`.**
    Open Terminal and run:
    ```bash
    openssl rand -hex 32
    ```
    Copy the 64-character hex string into `GOOGLE_TOKEN_ENC_KEY=` in your `.env`.
    This key encrypts all OAuth tokens stored in the database.
    **If you lose or change this key, all stored tokens become unreadable and users will need to re-authorize.**

34a. **Run `db:push` and `db:rls` to initialize the database.**
    This is required before running the app for the first time.  Have the developer run from the project root:
    ```bash
    # 1. As a Postgres superuser, enable required extensions first:
    #    (Connect to your database with psql or a GUI client and run:)
    #    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    #    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    #
    # 2. Apply schema (creates all tables and schemas):
    pnpm db:push
    #
    # 3. Apply roles and RLS policies (creates app_runtime, app_exec, etc.):
    pnpm db:rls
    ```
    `db:push` uses `DATABASE_URL` (superuser). `db:rls` also uses `DATABASE_URL`.
    Both steps are required; `db:rls` must run after `db:push`.

35. **Paste the values** from your notes:
    - `GOOGLE_CLIENT_ID=` ← from step 20
    - `GOOGLE_CLIENT_SECRET=` ← from step 20
    - `GOOGLE_TOKEN_ENC_KEY=` ← from step 34 (openssl output)
    - `GOOGLE_SHEETS_AUDIT_ID=` ← from step 31
    - `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH=` ← from step 26 (absolute path)

36. **Save and close.** `⌘+S` then close TextEdit.

37. **Confirm `.env` is actually ignored.** From Terminal:
    ```bash
    cd ~/code/exec-db
    git check-ignore -v .env
    ```
    You should see a line like `.gitignore:5:.env  .env` — proving the file is ignored *and* showing which rule did it. If the command prints nothing or exits with a non-zero status, **stop and tell the dev** — the secrets are about to commit. (`grep '^.env' .gitignore` is not enough: `.` is a regex wildcard and later negation rules can override an earlier match.)

---

## Category 8 — Verify (5 min)

38. **Check the Sheet permissions.**
    Open the audit-log Sheet → Share → confirm `exec-db-audit-writer@…` has **Editor** access.

39. **Check OAuth consent screen status.**
    GCP console → APIs & Services → OAuth consent screen → confirm status is **In production** (Internal apps don't need verification).

40. **Check enabled APIs.**
    APIs & Services → Enabled APIs & services → confirm all four: Calendar, Gmail, Sheets, People API.

41. **Send the dev a "go" signal.**
    Tell them P1–P4 are complete and `.env` is populated. They can start `claude/pr2-foundation`.

---

## Troubleshooting cheat sheet

| Symptom | Fix |
|---|---|
| "Internal" greyed out on consent screen (step 11) | Your account isn't a Workspace admin. Have a super-admin do this category. |
| "User type cannot be Internal" error | Project isn't owned by a Workspace org. Recreate project under your organization (step 2.4). |
| Calendar API quota errors at runtime | Default quota is fine for ≤10 execs. Bump under APIs & Services → Quotas if you exceed. |
| `gmail.send` accidentally added in step 15 | Edit → remove the scope → save. CI will block any code using send anyway (AD-004). |
| Service-account JSON file lost | Re-download: Credentials → service account → KEYS → ADD KEY → JSON. Old key still works until revoked. |
| Sheet writes fail with `403 PERMISSION_DENIED` | Service account email isn't on the Sheet share list (step 30). Re-add as Editor. |
| `.env` accidentally committed | Stop. From Terminal: `git rm --cached .env && git commit -m "remove leaked .env"`. Then **rotate** all secrets immediately. |
| `ERROR: function uuid_generate_v4() does not exist` | The `uuid-ossp` Postgres extension is not enabled. Run `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";` as a superuser (step 34a). |
| `ERROR: function pgp_sym_encrypt(text, text) does not exist` | The `pgcrypto` Postgres extension is not enabled. Run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` as a superuser (step 34a). |
| `GOOGLE_TOKEN_ENC_KEY env var is not set` | Add `GOOGLE_TOKEN_ENC_KEY=<your-generated-key>` to `.env` (step 34). |
| OAuth callback fails with "No of-record Google token found" | The OAuth flow completed but the token wasn't stored. Confirm `GOOGLE_TOKEN_ENC_KEY` is set and both `pgcrypto` and `uuid-ossp` extensions are enabled. |

---

## What you handed off

- A GCP project under your Workspace org with billing linked.
- Calendar / Gmail / Sheets / People APIs enabled.
- An Internal OAuth consent screen with five scopes (Calendar.readonly, Gmail.readonly, Gmail.compose, openid, email) and your domain authorized.
- A web-app OAuth client with `localhost:3000` redirects (staging/prod added in PR3).
- A service account that can only write to one Sheet — minimum privilege.
- A monthly audit-log Sheet with a frozen 11-column header row.
- `pgcrypto` and `uuid-ossp` Postgres extensions enabled.
- Database schema applied (`db:push`) and RLS roles + policies applied (`db:rls`).
- A `.env` file populated locally (not in git) so the dev can start PR2.

This is everything `docs/pr2-spec.md` prereqs P1–P4 require. The dev's first commit on `claude/pr2-foundation` (work-stream **D — redaction filter**) does not depend on any of this; commit **A — Google integration** does, and that's where these values get used.
