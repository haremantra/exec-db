# exec-db

Internal exec database — Phase 0 scaffold.

A read-optimized warehouse + thin operational app giving the executive team cross-functional visibility into Operations, Legal, Finance, HR, and Compensation. Mirrors data from systems of record (Rippling, Carta, QuickBooks, Ironclad, Stripe, etc.); does **not** replace them.

## Stack

| Layer | Tech |
|---|---|
| DB | Postgres 16 (schemas per domain, row-level security) |
| ORM/migrations | Drizzle |
| Transform | dbt Core (`transform/`) |
| App | Next.js 15 App Router + tRPC + Tailwind |
| Auth | WorkOS/Clerk (SAML SSO + SCIM) — stub in Phase 0 |
| Workers | BullMQ on Redis (Phase 1+) |
| Hosting | Vercel (app), Neon/RDS (db) |

## Repo layout

```
apps/web/             Next.js exec UI
packages/db/          Drizzle schemas + migrations + RLS SQL
transform/            dbt project (staging → intermediate → marts)
docs/                 Architecture & access-control reference
```

## Phase 0 deliverables (this scaffold)

- [x] Postgres schemas for the five domains + `core` + `audit`
- [x] Drizzle setup with typed clients
- [x] Three-tier RBAC (`exec_all`, `function_lead`, `manager`) enforced at the DB via RLS
- [x] Audit log table + trigger on `comp.*`
- [x] Session → Postgres GUC bridge so RLS sees the current user
- [x] `/status` page wired to a freshness-SLA view
- [x] dbt project skeleton

## Next phases

| Phase | Scope |
|---|---|
| 1 | Finance + HR ingestion (QuickBooks, Rippling), runway view, headcount view |
| 2 | Comp ingestion (Carta + Rippling), band-drift report |
| 3 | Legal (Ironclad/Drive), renewal calendar |
| 4 | Ops/KPIs (Stripe + product DB), MRR/NDR |
| 5 | Hardening: SOC 2 controls, DR runbook, quarterly access review |

## Setup

```bash
pnpm install
cp .env.example .env                       # fill in DATABASE_URL
pnpm --filter @exec-db/db db:push          # apply Drizzle schema
pnpm --filter @exec-db/db db:rls           # apply RLS roles + policies
pnpm --filter @exec-db/web dev             # http://localhost:3000
```

See `docs/architecture.md` and `docs/access-control.md` for the design rationale.
