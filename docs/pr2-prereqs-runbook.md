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
   3. **Project name**: `exec-db`. Leave the auto-generated **Project ID** as is, or change to `exec-db-prod` if `exec-db` is taken.
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

8. **(Optional) Enable the Google Sheets API.**
   Needed for the audit-log Sheet writer in P4.
   1. Back to Library.
   2. Search: `Google Sheets API`.
   3. **ENABLE**.

9. **Verify all three are on.**
   Left nav → **APIs & Services → Enabled APIs & services**. You should see *Google Calendar API*, *Gmail API*, and *Google Sheets API* listed.

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
    Click **ADD OR REMOVE SCOPES**. Tick exactly these three:
    - `https://www.googleapis.com/auth/calendar.readonly` — *See and download your calendars*
    - `https://www.googleapis.com/auth/gmail.readonly` — *Read all resources and their metadata*
    - `https://www.googleapis.com/auth/gmail.compose` — *Manage drafts and send emails* (we use it for **drafts only** — see PR2 spec invariant #1)

    **Do NOT add** `gmail.send`, `gmail.modify`, or any `userinfo` scopes. The spec forbids `gmail.send` everywhere.
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
    4. A `.json` file downloads. **Move it to** `~/exec-db-secrets/audit-writer.json` (create the folder if needed). Do NOT commit this file to git.
    5. **Copy the absolute path** of the file into your notes — you'll reference it from `.env`.

---

## Category 6 — Create the audit-log Google Sheet (10 min)

27. **Create the Sheet.**
    1. Open <https://sheets.google.com> in the same Workspace account.
    2. Click **+ Blank** to make a new sheet.
    3. **Rename** the file (top-left) to `exec-db prompt audit log YYYY-MM` (current year-month). The sheet rotates monthly later; this is the first one.

28. **Add the header row** (paste into row 1, A1):

    ```
    timestamp_utc | contact_id | model | prompt_class | redacted_input_hash | response_hash | input_tokens | output_tokens | cost_usd
    ```

    Paste that with **tab-separated cells** so it lands in A1:I1.

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

    # Audit-log Sheet (P4)
    GOOGLE_SHEETS_AUDIT_ID=
    GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH=/Users/<you>/exec-db-secrets/audit-writer.json
    ```

34. **Paste the values** from your notes:
    - `GOOGLE_CLIENT_ID=` ← from step 20
    - `GOOGLE_CLIENT_SECRET=` ← from step 20
    - `GOOGLE_SHEETS_AUDIT_ID=` ← from step 31
    - `GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY_PATH=` ← from step 26 (absolute path)

35. **Save and close.** `⌘+S` then close TextEdit.

36. **Confirm `.env` is gitignored.** From Terminal:
    ```bash
    grep -n '^.env' ~/code/exec-db/.gitignore
    ```
    You should see `.env` listed. If not, stop and tell the dev — the secrets must not commit.

---

## Category 8 — Verify (5 min)

37. **Check the Sheet permissions.**
    Open the audit-log Sheet → Share → confirm `exec-db-audit-writer@…` has **Editor** access.

38. **Check OAuth consent screen status.**
    GCP console → APIs & Services → OAuth consent screen → confirm status is **In production** (Internal apps don't need verification).

39. **Check enabled APIs.**
    APIs & Services → Enabled APIs & services → confirm all three: Calendar, Gmail, Sheets.

40. **Send the dev a "go" signal.**
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
| `.env` accidentally committed | Stop. From Terminal: `git rm --cached .env && git commit -m "remove leaked .env"`. Then **rotate** all four secrets immediately. |

---

## What you handed off

- A GCP project under your Workspace org with billing linked.
- Calendar / Gmail / Sheets APIs enabled.
- An Internal OAuth consent screen with exactly three scopes (Calendar.readonly, Gmail.readonly, Gmail.compose) and your domain authorized.
- A web-app OAuth client with `localhost:3000` redirects (staging/prod added in PR3).
- A service account that can only write to one Sheet — minimum privilege.
- A monthly audit-log Sheet with a frozen 9-column header row.
- A `.env` file populated locally (not in git) so the dev can start PR2.

This is everything `docs/pr2-spec.md` prereqs P1–P4 require. The dev's first commit on `claude/pr2-foundation` (work-stream **D — redaction filter**) does not depend on any of this; commit **A — Google integration** does, and that's where these values get used.
