# Access control

## Three tiers

| Tier | Who | Sees |
|---|---|---|
| `exec_all` | CEO, CFO, COO | Everything, including individual comp |
| `function_lead` | VPs | Their domain in full + aggregated views of others |
| `manager` | People managers | Their reporting tree (HR data only) |
| `employee` | (default) | Themselves only |

Fall-through: an authenticated user with no tier mapping defaults to `employee`.

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
