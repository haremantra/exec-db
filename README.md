# exec-db

Internal exec ops app: **CRM + PM for the exec team**, with autodraft email follow-ups (from call notes + Google Calendar + Gmail history) and daily/weekly task digests. Built on the existing exec-db data foundation (Postgres + Drizzle + RLS + audit) — the SaaS-mirror domains (`hr/comp/fin/legal/ops`) stay around to provide context joins (e.g. `core.employee_dim`), but the headline product is now the operational CRM/PM surfaces.

## Stack

| Layer | Tech |
|---|---|
| DB | Postgres 16 (schemas per domain, row-level security) |
| ORM/migrations | Drizzle |
| Transform | dbt Core (`transform/`) — for the mirror tier only |
| App | Next.js 15 App Router + Server Actions + Tailwind |
| LLM | Anthropic Claude (autodraft, digests, `pnpm vision-check`) |
| Auth | WorkOS/Clerk (SAML SSO + SCIM) — stub today |
| Workers | BullMQ on Redis (PR 2+) |
| Hosting | Vercel (app), Neon/RDS (db) |

## Repo layout

```
apps/web/             Next.js exec UI (CRM + PM + status)
packages/db/          Drizzle schemas + migrations + RLS SQL
transform/            dbt project (mirror tier only)
scripts/              One-off CLIs (vision-check)
docs/                 Architecture & access-control reference
```

## Roadmap

| PR | Scope |
|---|---|
| 1 (this) | `crm` + `pm` schemas with RLS + audit; CRM contacts/notes UI; PM projects/tasks UI; `pnpm vision-check` CLI |
| 2 | Google OAuth + Calendar sync + Gmail thread reader + Gmail draft writer |
| 3 | Autodraft worker (call note → drafted follow-up in Gmail); daily/weekly task-digest worker |

The pre-pivot warehouse plan (Phase 1–5: Finance + HR + Comp + Legal + Ops ingestion) is paused; the schemas remain so `core.employee_dim` and friends are available for CRM/PM joins.

## Setup

```bash
pnpm install
cp .env.example .env                       # fill in DATABASE_URL + ANTHROPIC_API_KEY
pnpm --filter @exec-db/db db:push          # apply Drizzle schema
pnpm --filter @exec-db/db db:rls           # apply RLS roles + policies + audit triggers
pnpm --filter @exec-db/web dev             # http://localhost:3000
pnpm vision-check                          # interview yourself about the product vision
```

See `docs/architecture.md` and `docs/access-control.md` for the design rationale.
