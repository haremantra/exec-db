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

## Assistant role (AD-002 / US-023 / PR2-H)

An executive may invite their Chief-of-Staff or EA to read CRM and PM data. This is the `assistant` tier.

### Grant model

Access is controlled via `crm.assistant_grant`:

| Column | Type | Description |
|---|---|---|
| `id` | `uuid pk` | Primary key. |
| `exec_user_id` | `uuid not null` | The exec who granted access. |
| `assistant_user_id` | `uuid not null` | The assistant receiving access. |
| `granted_at` | `timestamptz not null default now()` | When the grant was created. |
| `revoked_at` | `timestamptz` | Null while active; set to `now()` on revocation. |

A unique partial index `(exec_user_id, assistant_user_id) WHERE revoked_at IS NULL` prevents duplicate active grants and allows re-granting after revocation.

### Granting and revoking

- **Invite**: `inviteAssistant(formData)` — `exec_all` only. Resolves `email` against `core.employee_dim.work_email`; errors if not found. Creates a `crm.assistant_grant` row.
- **Revoke**: `revokeAssistant(grantId)` — `exec_all` only. Sets `revoked_at = now()` on the specified grant row (scoped to the exec's own grants only).

Both actions are accessible from `/settings/assistants` (page visible to `exec_all` tier only).

### Role-tier mapping

| Postgres role | App tier | Access |
|---|---|---|
| `app_assistant` | `assistant` | Read-only: `crm.*` + `pm.*`. Sensitive contacts hidden. |

The `app_assistant` Postgres role is created in `packages/db/src/rls/roles.sql` and granted `USAGE` + `SELECT` on `crm` and `pm` schemas. The `app_runtime` login role inherits `app_assistant` so the app can set the per-request tier GUC via `withSession()`.

### Tier rank

```
exec_all:       100
function_lead:   50
manager:         20
assistant:       10
employee:         0
```

The `assistant` tier sits between `manager` and `employee`. Assistants have read-only access to CRM/PM and cannot call any action that requires `exec_all`.

### Sensitive-contact hiding interaction

Adding `'assistant'` to the `contact_read` (and related) RLS policy whitelists does **not** bypass sensitive-flag hiding. The `crm.is_sensitive_for_role(contact_id uuid)` SQL helper returns `TRUE` whenever:

```sql
app.current_tier() <> 'exec_all'
AND EXISTS (SELECT 1 FROM crm.contact WHERE id = p_contact_id AND sensitive_flag IS NOT NULL)
```

Since `'assistant'` is not `'exec_all'`, any contact with a non-null `sensitive_flag` is invisible to assistant sessions — exactly the same as `function_lead` and `manager` tiers (AD-001, US-014). The regression test in `apps/web/__tests__/assistant-grant.test.ts` (sensitive-flag hiding suite) verifies this invariant.

## SOC 2 alignment

The above plus: change management on `packages/db` migrations (PR + review + audit), backup PITR with monthly restore drill, and a sub-processor list checked into `docs/`. Cheap to do from day one; expensive to retrofit.
