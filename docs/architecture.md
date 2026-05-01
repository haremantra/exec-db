# Architecture

## Two tiers, not one

| Tier | Purpose | Tech |
|---|---|---|
| Operational (the product) | CRM + PM: contacts, call notes, autodrafted follow-ups, projects, tasks, digests. **This app is the system of record.** | Postgres + Next.js + Claude API |
| Mirror (context) | Read-only copy of HR/Comp/Finance/Legal/Ops data from external SaaS. Append-only, SCD2. Used to enrich CRM/PM with `core.employee_dim`, customer context, etc. | Postgres → BigQuery/Snowflake when >100GB |

The mirror tier still does not own HR/comp/finance/legal/product data — those live in Rippling, Carta, QuickBooks, Ironclad, Stripe. The operational tier (`crm`, `pm`) is the only place this app is authoritative.

## Domain model

| Domain | SoT | Schema | Key entities |
|---|---|---|---|
| **CRM** | **this app** | **`crm`** | **`contact`, `account`, `call_note`, `calendar_event`, `email_thread`, `draft`** |
| **PM** | **this app** | **`pm`** | **`project`, `task`, `task_dependency`, `digest_send`** |
| Core (dimensions) | this app | `core` | `entity_dim`, `employee_dim`, `customer_dim`, `vendor_dim`, `date_dim` |
| HR | Rippling/Gusto/Deel | `hr` | `org_unit`, `employment`, `manager_edge`, `leave` |
| Compensation | Rippling + Carta + sheets | `comp` | `comp_band`, `salary`, `bonus`, `equity_grant`, `vesting_schedule` |
| Finance | QuickBooks/Xero + bank + Stripe + Brex | `fin` | `gl_account`, `transaction`, `invoice`, `bill`, `bank_balance`, `runway_snapshot` |
| Legal | Ironclad/DocuSign/Drive | `legal` | `contract`, `counterparty`, `obligation`, `renewal_event` |
| Operations | Stripe + product DB + Linear | `ops` | `subscription`, `mrr_snapshot`, `incident`, `okr`, `kpi_snapshot` |
| Audit | this app | `audit` | `access_log`, `export_log` |

Every fact and slowly-changing dim embeds the SCD2 lineage columns in `core.lineage`: `_ingested_at`, `_source_system`, `_source_id`, `_valid_from`, `_valid_to`.

## Identity resolution

The same human appears in Rippling, Carta, Google Workspace, Stripe, and your IdP under different IDs and sometimes different emails. The `core.employee_dim` table holds the canonical record with explicit cross-source IDs (`rippling_id`, `carta_stakeholder_id`, etc.). Every staging model joins back through these. Identity bugs you don't fix here become join bugs everywhere downstream.

## Ingestion

| Cadence | Domains | Mechanism |
|---|---|---|
| ~5 min | ops (incidents, churn signals) | Custom worker on BullMQ |
| Hourly | finance (bank balances, AR aging) | Airbyte/Fivetran |
| Daily | HR, comp, legal | Airbyte/Fivetran |

Every successful sync inserts into `core.freshness_log`. The `/status` page reads from there and flags any source past its SLA.

## Transform

dbt Core, in `transform/`. `staging/` mirrors raw tables 1:1 with light cleanup. `intermediate/` adds business logic (e.g., resolving `manager_edge` into a recursive tree). `marts/` produces the exec-facing tables backing each home-page question.

## App

Next.js 15 App Router. Each exec question is one mart + one page. Resist building a generic BI tool — Metabase/Hex exists for ad-hoc; the bespoke app is for recurring board-prep surfaces.
