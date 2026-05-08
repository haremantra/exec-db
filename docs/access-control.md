# Access control

## Three tiers

| Tier | Who | Sees |
|---|---|---|
| `exec_all` | CEO, CFO, COO | Everything, including individual comp. **Read+write on `crm.*` and `pm.*`.** |
| `function_lead` | VPs | Their domain in full + aggregated views of others. **Read-only on `crm.*` and `pm.*`.** |
| `manager` | People managers | Their reporting tree (HR data only). **Read-only on `crm.*` and `pm.*`.** |
| `employee` | (default) | Themselves only. No CRM/PM access today, but `pm.task` policy already permits self-owned rows so a future audience expansion is a one-line change. |

Fall-through: an authenticated user with no tier mapping defaults to `employee`.

Every write to `crm.*` and `pm.*` is logged via audit trigger to `audit.access_log` (same defense-in-depth pattern as `comp.*`).

## Defense in depth — four enforcement layers

1. **Schema grants.** `comp.*` is granted only to `app_exec`. The default app role (`app_runtime`) cannot `SELECT` from comp tables at all.
2. **Row-level security.** Every HR/comp table has RLS enabled with `FORCE ROW LEVEL SECURITY` so it applies even to table owners. Policies read session GUCs (`app.user_id`, `app.tier`, `app.function_area`) set per request via `withSession()` in `packages/db/src/client.ts`.
3. **Audit triggers.** Any write to `comp.*` writes a row to `audit.access_log`. The app also calls `recordAccess()` to capture richer query-hash + intent context.
4. **Aggregate guard.** Mart views over comp aggregates use `app.assert_min_cell_size(n, 5)` to prevent re-identification (no cell with N<5).

## Authentication

Phase 0 ships a stub auth module. Phase 1 swaps to WorkOS or Clerk:

- SAML SSO via your Google Workspace IdP
- SCIM provisioning so directory groups become tier roles automatically
- Session lifetime ≤ 8h, MFA required for `exec_all`
- IP allowlist (optional) for the comp dashboard

## Exports

Every CSV/PDF export inserts into `audit.export_log` with a watermark string (user email + timestamp + intent). PDFs are watermarked visually. There is no API path that streams comp rows without writing to the export log first.

## Quarterly access review

Automate a report from `audit.access_log` joined to `core.employee_dim`: who has each tier, when they last used it, and what they accessed. CEO signs off. Anyone inactive for 60 days is downgraded.

## OAuth token encryption (PR2 — Stream A)

### Storage model

Google OAuth tokens for each user are stored in `crm.oauth_token`. The columns
`access_token_enc` and `refresh_token_enc` are `bytea` values produced by
PostgreSQL's **pgcrypto** extension:

```sql
pgp_sym_encrypt(plaintext_token::text, $GOOGLE_TOKEN_ENC_KEY)
```

Decryption happens at query time inside the DB connection:

```sql
pgp_sym_decrypt(access_token_enc, $GOOGLE_TOKEN_ENC_KEY)::text
```

The symmetric key (`GOOGLE_TOKEN_ENC_KEY`) is **never stored in the database**.
It lives exclusively in the `.env` file on the server and is injected as a
query parameter at runtime via `apps/web/lib/google.ts`.

### Key requirements

- Minimum 32 bytes of entropy (use `openssl rand -base64 32` to generate).
- Rotate by: (1) generate a new key, (2) re-encrypt all rows in a transaction,
  (3) deploy the new key.
- Loss of the key means all stored tokens become unreadable — users must
  re-authorize via `/api/auth/google`.

### Of-record account semantics (AD-007)

Each user may connect multiple Google accounts (personal + professional). The
`is_of_record` flag marks the single account whose tokens are used for all
Google API calls. `googleClientForUser()` always selects the row with
`is_of_record = true`.

- First account connected automatically gets `is_of_record = true`.
- To switch of-record account: update the row (exec-only via RLS) or add a
  future settings UI.
- RLS on `crm.oauth_token`: users may only read/write their own rows;
  `exec_all` can SELECT all (audit visibility) and DELETE (revocation).

### Scope justifications

| Scope | Justification |
|---|---|
| `calendar.readonly` | Read primary calendar events to populate `crm.calendar_event` (S6.4, S6.7). |
| `gmail.readonly` | Read thread bodies for pre-call briefing context (S6.6 override, W2.4). |
| `gmail.compose` | Create drafts in Gmail. **Never sends.** `gmail.send` is explicitly excluded from the consent screen and forbidden in code (AD-004). |
| `openid`, `email` | Identify which Google account is being connected (userinfo). |

`gmail.send` is **never requested** and **never called**. CI lint (stream J)
blocks any future introduction of `users.messages.send`.

## SOC 2 alignment

The above plus: change management on `packages/db` migrations (PR + review + audit), backup PITR with monthly restore drill, and a sub-processor list checked into `docs/`. Cheap to do from day one; expensive to retrofit.
