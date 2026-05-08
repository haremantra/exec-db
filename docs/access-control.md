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

## SOC 2 alignment

The above plus: change management on `packages/db` migrations (PR + review + audit), backup PITR with monthly restore drill, and a sub-processor list checked into `docs/`. Cheap to do from day one; expensive to retrofit.

## LLM audit log retention (AD-005)

`audit.llm_call` is **append-only** and retained for **365 days minimum**.

- No `UPDATE` or `DELETE` RLS policies exist on `audit.llm_call`. The table is INSERT-only from the application layer.
- A delete-prevention `RULE` (`llm_call_no_delete`) and an update-prevention `RULE` (`llm_call_no_update`) are installed in `packages/db/src/rls/policies.sql`. Any attempt to `DELETE` or `UPDATE` rows raises a division-by-zero exception, preventing the operation at the database level even for superusers who bypass RLS.
- `app_exec` can SELECT all rows. `app_function_lead` and `app_assistant` can SELECT all rows (TODO stream C: tighten to exclude sensitive contacts once `crm.contact.sensitive_flag` lands).
- INSERT is restricted to `app_exec`; `recordLlmCall()` always runs under a synthetic exec-tier session for this reason.
- The secondary Google Sheet (SY-017) is a human-readable export tier. The Postgres table is the authoritative source of truth. Sheet failures are logged but never propagate to the caller.

## `app_assistant` role (AD-002)

A new `app_assistant` Postgres role was added in PR2-E to satisfy AD-002 (Chief-of-Staff / EA access). It has:

- `USAGE` on schemas `core`, `hr`, `fin`, `legal`, `ops`, `audit`, `crm`, `pm`.
- `SELECT` on `crm.*` and `pm.*` (read-only; sensitive contacts hidden per future stream C hardening).
- `INSERT` on `audit.*` (same as other non-exec roles).
- No `UPDATE` or `DELETE` on any table.

The `app_runtime` login role inherits `app_assistant` so the app can `SET ROLE app_assistant` per request.
