# PR1 spec — exec-db foundation

_Source of truth for in-scope/out-of-scope. Derived from `docs/scope-answers.md` (defaults) and verified against existing scaffolding._

## Already done (no work needed)
- Drizzle schemas: `crm.contact`, `crm.account`, `crm.call_note`, `pm.project`, `pm.task`, `pm.task_dependency`, `audit.access_log`, `audit.export_log`.
- Web routes: `/crm/contacts` (list+form), `/crm/contacts/[id]` (detail + note form + draft discard), `/pm/projects` (list+form), `/pm/projects/[id]` (kanban + task form).
- Server actions: `createContact`, `addCallNote`, `discardDraft`, `createProject`, `createTask`, `updateTaskStatus`.
- Stub auth + `withSession` RLS-context wrapper + RBAC types.
- `db:push`, `db:rls`, `db:studio` scripts wired.
- Top nav: already CRM + PM only; SaaS mirror not linked → S1.5 satisfied.

## In scope for this PR (~11–14 engineering hours)

| # | Item | Hours | Source |
|---|---|---|---|
| 1 | RLS policies for `crm.*`, `pm.*`, `audit.*` (exec_all CRUD; function_lead/manager read deferred per S7.4) | 3–5 | S7.1, S7.4 |
| 2 | Grant `crm`/`pm`/`audit` schema usage to `app_runtime` role in `roles.sql` | 0.5 | follow-on to #1 |
| 3 | Seed script: 5 contacts, 2 accounts, 3 projects, 6 tasks, 2 call notes — `pnpm db:seed` | 2–3 | S9.6 |
| 4 | Markdown rendering for call notes + draft body (server-side `remark` → sanitized HTML) | 2–3 | S2.5, S3.7 |
| 5 | 24h edit window on `crm.call_note`: server action checks `created_at + 24h > now()` before updating; otherwise reject | 1–2 | S2.6 |
| 6 | Smoke tests: 1 vitest per server action × 6 actions, in `apps/web/__tests__/` | 2–3 | S9.5 |
| 7 | `pnpm typecheck` + `pnpm test` green; manual verification of golden path on `localhost:3000` | 0.5 | done-criteria |

**Total**: 11–17 hours (well under PR1's 55–108h estimate, because scaffolding pre-exists).

## Out of scope (deferred per defaults)

- Real auth (Clerk) — S7.1 "stub OK for PR1; real auth in PR2"
- Account UI — S2.2 "backend table only"
- Tags / stage / last-touch on contact — S2.1 "name/email/company/title only"
- Function_lead/manager read access — S7.4 "exec_all only in v1"
- Audit triggers — S7.6 "deferred to PR3"
- Mobile responsiveness — S1.4 "desktop-only"
- Recurring tasks, dependencies UI, comments — S4.3, S4.4, S4.5
- Polished styling — S9.8 "minimal"
- Vision-check changes — S8.1 already shipped, no work in PR1

## Done definition (S10.7)
PR1 merged + an exec on staging can:
1. Sign in (stub)
2. Create a contact
3. Open the contact, add a markdown call note, see it rendered
4. Create a project, add a task, move it through the kanban
5. Run `pnpm db:seed` and see demo rows
6. `pnpm typecheck && pnpm test` are green

## Branch + PR plan
- Branch: `claude/pr1-foundation`
- Commit cadence: one commit per item above (7 commits), each runnable on its own.
- PR title: `PR1: foundation — RLS policies, seed, markdown, edit window, smoke tests`
- Squash merge on approval.

## Risks
- `remark` + sanitization adds ~50KB to the bundle; acceptable for desktop-only exec UI.
- 24h edit window is local-time-of-server. Single-TZ default (S5.8) makes this safe.
- RLS policies ship without function_lead/manager paths — easy to extend in PR2 but worth documenting in `docs/access-control.md`.
