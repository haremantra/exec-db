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
