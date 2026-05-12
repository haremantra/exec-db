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

### Clerk-backed auth (active)

Production and staging use **Clerk** as the identity provider (`AUTH_PROVIDER=clerk`).

#### How `getSession()` resolves a Clerk ID to an employee_dim row

```
Request arrives at a server component or server action
  │
  ├─ clerkMiddleware() (apps/web/middleware.ts)
  │     Verifies the Clerk session JWT; rejects unauthenticated requests
  │     except for explicitly public routes (see middleware.ts).
  │
  └─ getSession()  (apps/web/lib/auth.ts)
       │
       ├─ auth()  ← @clerk/nextjs/server: returns { userId: "user_2abc…" } or null
       │
       ├─ If userId is null → return null  (not authenticated)
       │
       ├─ SELECT crm.user_link WHERE clerk_user_id = userId
       │
       ├─ If no row → log warning + return null  (user not provisioned)
       │   Admin must run: pnpm provision-user --clerk-id=… --email=… --tier=…
       │
       └─ Return Session {
            userId: row.employee_id,   ← the employee_dim UUID used everywhere
            email:  clerk.emailAddresses[0],
            tier:   row.tier,
            functionArea: row.function_area,
          }
```

The `Session` shape is unchanged — every server action that calls `getSession()` continues to work without modification.

#### crm.user_link provisioning

Admin-only. No user can self-provision. Steps:

1. User signs up via Clerk (`/sign-up`).
2. Admin copies their Clerk user ID from the Clerk dashboard → Users.
3. Admin runs:
   ```bash
   pnpm provision-user --clerk-id=user_xyz --email=user@company.com --tier=exec_all
   ```
   Or to use a specific UUID:
   ```bash
   pnpm provision-user --clerk-id=user_xyz --employee-uuid=<uuid> --tier=exec_all
   ```
4. The `crm.user_link` row is created (upserted — idempotent).

#### RLS interaction

`getSession()` reads `crm.user_link` before the tier is known, so the SELECT runs as `app_runtime` without GUC-level context. The RLS policy on `user_link` permits `SELECT` unconditionally (see `packages/db/src/rls/policies.sql`). This is safe — the table contains no sensitive data beyond the Clerk⟷UUID mapping. All writes require `exec_all` tier.

#### Offboarding

1. Delete the `crm.user_link` row:
   ```sql
   DELETE FROM crm.user_link WHERE clerk_user_id = 'user_xyz';
   ```
   `getSession()` will return `null` on the next request, which redirects to `/sign-in`.
2. Disable/delete the user in the Clerk dashboard to prevent token refresh.
3. Optionally revoke any active `crm.assistant_grant` rows for the user.

#### Local dev (stub mode)

For local development set `AUTH_PROVIDER=stub` in `.env`. The stub reads from headers/cookies and defaults to the dev UUID `00000000-0000-0000-0000-000000000001` (tier `exec_all`) when none are present. Stub mode is disabled in production even if `AUTH_PROVIDER=stub` is set.

- SAML SSO via your Google Workspace IdP is available as a future Clerk configuration option.
- MFA required for `exec_all` can be enforced in the Clerk dashboard under **Security → MFA**.
- IP allowlist (optional) for the comp dashboard can be added as a Clerk organization policy or edge middleware.

## Exports

Every CSV/PDF export inserts into `audit.export_log` with a watermark string (user email + timestamp + intent). PDFs are watermarked visually. There is no API path that streams comp rows without writing to the export log first.

## Quarterly access review

Automate a report from `audit.access_log` joined to `core.employee_dim`: who has each tier, when they last used it, and what they accessed. CEO signs off. Anyone inactive for 60 days is downgraded.

## Sensitive contacts

Added in PR2-C (stories US-014, AD-001, SY-008, AD-008).

### Six-tag taxonomy

A contact may carry at most one sensitive flag, chosen from the following values (`varchar(32)`, enforced by a `CHECK` constraint on `crm.contact.sensitive_flag`):

| Value | Meaning |
|---|---|
| `rolled_off_customer` | Customer who ended their engagement — their notes/emails should not bleed into active-customer context. |
| `irrelevant_vendor` | Salesperson pitching a service the exec does not need. |
| `acquisition_target` | Company under consideration for M&A — strictly confidential. |
| `loi` | Letter of intent in flight — extreme confidentiality. |
| `vc_outreach` | Venture-capital firm that reached out for investment discussions. |
| `partnership` | Prospective or active partner whose deal terms are non-public. |

`NULL` (the default) means the contact is not sensitive.

### Visibility per role

| Role / Tier | Sees sensitive contacts? |
|---|---|
| `exec_all` | Always — the full record including the flag value. |
| `function_lead` | Never — rows are hidden by RLS. |
| `manager` | Never — rows are hidden by RLS. |
| `app_assistant` (Stream H, not yet active) | Never — falls into the non-exec_all branch automatically. |
| `employee` | Never — employees have no CRM access regardless. |

The visibility rule is enforced at the database layer by the helper function `crm.is_sensitive_for_role(contact_id uuid)` in `packages/db/src/rls/policies.sql`.  It returns `TRUE` (hide the row) when:

```sql
app.current_tier() <> 'exec_all'
AND EXISTS (SELECT 1 FROM crm.contact WHERE id = p_contact_id AND sensitive_flag IS NOT NULL)
```

Policies on `crm.call_note`, `crm.calendar_event`, and `crm.email_thread` call this function so that notes, events, and threads belonging to a sensitive contact are also hidden from non-exec roles.

### RLS recursion safety (PR2-J)

**Concern (Copilot review on PR #19):** `crm.is_sensitive_for_role()` is `SECURITY DEFINER` and reads from `crm.contact`, which has RLS enabled.  Could Postgres recurse infinitely — outer query triggers policy, policy calls function, function queries table, table policy fires again?

**Analysis:** No recursion occurs.  The function is `SECURITY DEFINER`, so its body executes under the privileges of its *definer* role (the migration role or schema owner, which has `BYPASSRLS`).  When a `BYPASSRLS` role queries `crm.contact` inside the function body, Postgres does not evaluate RLS on that inner query at all.  The cycle is broken at the first level.

Additionally, the function uses `SET search_path = crm, public`, which prevents a malicious caller from injecting a shadow `crm.contact` view to subvert the lookup.

**Decision:** The implementation is safe.  No policy logic was changed.  The analysis is also recorded as a comment directly in `packages/db/src/rls/policies.sql` for future reviewers.

### Setting / clearing the flag

Only `exec_all` tier may call the `setSensitiveFlag(contactId, formData)` server action.  The action:

1. Asserts `session.tier === 'exec_all'`.
2. Validates the flag value against `SENSITIVE_FLAG_VALUES`.
3. Updates `crm.contact.sensitive_flag`.
4. Writes an `audit.access_log` row (intent: `setSensitiveFlag contactId=… flag=…`).
5. Revalidates the contact page cache.

The flag is reversible: pass `"none"` or `null` to clear it.

### Full-text search exclusion (I2 — US-008)

The `/crm/search` page and the `searchCallNotes()` helper in `apps/web/lib/note-search.ts`
enforce sensitive-contact exclusion at **two independent layers**:

1. **RLS (database layer):** The existing `crm.is_sensitive_for_role()` function hides
   sensitive-contact rows from any non-`exec_all` database role before the query result
   reaches the application.  This is the primary enforcement mechanism added in PR2-C.

2. **Application layer (double-fence):** `searchCallNotes()` independently adds a
   `WHERE crm.contact.sensitive_flag IS NULL` condition to every query for non-`exec_all`
   callers.  This ensures that even if the RLS policy were bypassed or misconfigured,
   sensitive notes would still be excluded.

#### Sensitive-search toggle behaviour

| Caller tier | `includeSensitive` option | Sensitive contacts in results? |
|---|---|---|
| `exec_all` | `false` (default) | No |
| `exec_all` | `true` | Yes |
| Any non-exec tier | `true` (set by caller) | No — option is **silently ignored** |
| Any non-exec tier | `false` | No |

The "silently ignored" behaviour is intentional: a non-exec caller passing `includeSensitive=true`
gets the same result as `includeSensitive=false`, with no error raised.  The front-end
checkbox is only rendered for `exec_all` sessions, so this case should not arise in
normal use; the guard exists for defence-in-depth against direct API or programmatic calls.

This invariant is proven by `apps/web/__tests__/note-search.test.ts` (runs on every push).

### Cross-pollination invariant

> **Invariant (SY-008 / AD-008):** When generating any draft or briefing for contact A, no data belonging to a different contact B is retrieved as LLM context.

Enforcement is two-layered:

1. **Single-contact scope** — `apps/web/lib/contact-context.ts` is the only sanctioned entry point for fetching LLM context.  Every query inside it is filtered by the requested `contactId`.  The function signature and leading comment document this contract for Stream B (autodraft) and Stream F (briefing).

2. **Runtime invariant check** — after each query, every returned row is validated: `row.contactId === contactId`.  If any mismatch is detected, the function throws:
   ```
   [contact-context] Cross-pollination invariant violated in callNote:
   expected contact_id="aaa…" but got "bbb…"
   ```
   This acts as a loud regression guard so a future refactor that accidentally widens a query is caught in CI before it reaches production.

The invariant is proven by `apps/web/__tests__/cross-pollination.test.ts` (10 tests), which runs on every push via CI.

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

## Offboarding / personal export (US-026 / AD-006 / PR3-S)

An `exec_all` user may export their entire CRM as a portable zip archive via
`GET /api/export/crm` or the **Settings → Export** page.

### What is included

- One JSON file per CRM/PM table: `contact.json`, `account.json`,
  `call_note.json`, `draft.json`, `calendar_event.json`,
  `email_thread.json`, `project.json`, `task.json`.
- One `.md` file per call note inside a `notes/` folder, with YAML
  frontmatter (contact name, `contact_id`, `occurred_at`, `author_id`,
  `is_starred`) followed by the note body in markdown.
- **Sensitive contacts are included** — this is the exec's own data.
  The exec is not exporting data belonging to others; they are exporting
  their own CRM records before offboarding.

### Rate limit

One successful export per user per **24 hours**. The limit is enforced by
querying `audit.access_log` for rows with `intent LIKE 'crm_export%'` in
the last 24h for the requesting user.  Exceeding the limit returns HTTP 429.

### Audit log

Every successful export writes a row to `audit.access_log` with:
- `action = 'EXPORT'`
- `intent = 'crm_export userId=<id> file=<filename>'`
- `metadata` containing `filename`, `userId`, and `exportedAt` timestamp.

Non-exec roles (function_lead, manager, assistant, employee) cannot access
the export endpoint and will receive HTTP 403.

## SOC 2 alignment

The above plus: change management on `packages/db` migrations (PR + review + audit), backup PITR with monthly restore drill, and a sub-processor list checked into `docs/`. Cheap to do from day one; expensive to retrofit.

## LLM audit log retention (AD-005)

`audit.llm_call` is **append-only** and retained for **365 days minimum**.

- No `UPDATE` or `DELETE` RLS policies exist on `audit.llm_call`. The table is INSERT-only from the application layer.
- A `BEFORE UPDATE OR DELETE` trigger (`llm_call_no_mutate`) in `packages/db/src/rls/policies.sql` fires before any mutation reaches storage and raises: `audit.llm_call is append-only (PR2 SY-017/AD-005)`. This replaces the previous `DO INSTEAD (SELECT 1/0)` rules which were replaced in PR2-J for clarity (Copilot review on PR #19).
- `app_exec` can SELECT all rows. `app_function_lead` and `app_assistant` can SELECT all rows (TODO stream C: tighten to exclude sensitive contacts once `crm.contact.sensitive_flag` lands).
- INSERT is restricted to `app_exec`; `recordLlmCall()` always runs under a synthetic exec-tier session for this reason.
- The secondary Google Sheet (SY-017) is a human-readable export tier. The Postgres table is the authoritative source of truth. Sheet failures are logged but never propagate to the caller.

## Full-text search exclusion (I2 — US-008)

The `/crm/search` page and the `searchCallNotes()` helper in `apps/web/lib/note-search.ts`
enforce sensitive-contact exclusion at **two independent layers**:

1. **RLS (database layer):** The existing `crm.is_sensitive_for_role()` function hides
   sensitive-contact rows from any non-`exec_all` database role before the query result
   reaches the application.  This is the primary enforcement mechanism added in PR2-C.

2. **Application layer (double-fence):** `searchCallNotes()` independently adds a
   `WHERE crm.contact.sensitive_flag IS NULL` condition to every query for non-`exec_all`
   callers.  This ensures that even if the RLS policy were bypassed or misconfigured,
   sensitive notes would still be excluded.

### Sensitive-search toggle behaviour

| Caller tier | `includeSensitive` option | Sensitive contacts in results? |
|---|---|---|
| `exec_all` | `false` (default) | No |
| `exec_all` | `true` | Yes |
| Any non-exec tier | `true` (set by caller) | No — option is **silently ignored** |
| Any non-exec tier | `false` | No |

The "silently ignored" behaviour is intentional: a non-exec caller passing `includeSensitive=true`
gets the same result as `includeSensitive=false`, with no error raised.  The front-end
checkbox is only rendered for `exec_all` sessions, so this case should not arise in
normal use; the guard exists for defence-in-depth against direct API or programmatic calls.

This invariant is proven by `apps/web/__tests__/note-search.test.ts` (runs on every push).

## `app_assistant` role (AD-002)

A new `app_assistant` Postgres role was added in PR2-E to satisfy AD-002 (Chief-of-Staff / EA access). It has:

- `USAGE` on schemas `core`, `hr`, `fin`, `legal`, `ops`, `audit`, `crm`, `pm`.
- `SELECT` on `crm.*` and `pm.*` (read-only; sensitive contacts hidden per future stream C hardening).
- `INSERT` on `audit.*` (same as other non-exec roles).
- No `UPDATE` or `DELETE` on any table.

The `app_runtime` login role inherits `app_assistant` so the app can `SET ROLE app_assistant` per request.
