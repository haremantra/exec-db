# Architecture

## Retrospective + check-in (Stream R — PR3-R)

### Weekly retrospective view (`/retrospective`)

Implements US-022 (W8.4) — exec's Friday/Sunday self-scoring of the week.

**Route**: `apps/web/app/retrospective/page.tsx` — server component, `force-dynamic`.

**Data flow**:
```
GET /retrospective
  │
  ├─ getSession() — redirect to sign-in if null
  │
  ├─ SELECT pm.task JOIN pm.project
  │     WHERE owner_id = session.userId
  │       AND status = 'done'
  │       AND completed_at >= now() - interval '7 days'
  │
  ├─ Group by pm.project.name for display
  │
  ├─ "Jobs-to-be-done resolved" subset:
  │     impact IN ('revenue', 'reputation', 'both') AND status = 'done'
  │
  └─ Per-task <form> → recordRetrospectiveJudgement(taskId, formData)
       ├─ Reads "judgement" field from FormData
       ├─ Validates ∈ {"kept_promise", "partial", "broke_promise"}
       └─ INSERT audit.access_log intent="retrospective_judgement"
            metadata: { taskId, judgement }
            (used for future ranker training — see TODO in actions.ts)
```

**Files**:
| File | Purpose |
|---|---|
| `apps/web/app/retrospective/page.tsx` | Server component rendering retrospective view |
| `apps/web/app/retrospective/actions.ts` | `recordRetrospectiveJudgement` server action |

**Nav link**: added between `/dashboard` and `/crm` in `apps/web/app/layout.tsx`.

### Awaiting-response check-in badge (R2 — SY-010, US-020)

Extends `apps/web/app/pm/projects/[id]/page.tsx` (additive).

When a task has `awaiting_response_until` set and that timestamp is in the past
(`awaitingResponseUntil < new Date()`), the task card shows:

- An **orange "Needs check-in" badge** surfacing the delegation gap.
- A **"Draft check-in" link** to `/crm/contacts?draft_checkin=1&task_title=<title>`,
  which pre-fills the autodraft generation flow (Stream B / `generateAutodraft`)
  with the task title as context. No new server action required — consumes the
  `awaiting_response_until` column added by Stream K.

The badge is purely additive — it does not affect the 5-column kanban layout,
existing filters, or any other task-card content.

### Pending-draft reminder in digest (R3 — US-013, W4.3)

Extends `apps/web/lib/digest-body.ts` (additive section, clearly marked).

A new `crm.draft` query runs after the tasks fetch:
```sql
SELECT draft.*, contact.full_name
FROM crm.draft
LEFT JOIN crm.contact ON draft.contact_id = contact.id
WHERE draft.status = 'pending'
  AND draft.generated_at < now() - interval '24h'
```

The results render as a `## Drafts pending review (>24h)` markdown section
containing: contact name (linked to contact page), draft subject, generated_at.

**Concurrency note**: Stream R's section is inserted **after** Stream P's
"Top priorities" block and **before** Stream N's "Slipped" block, as a
clearly-marked `// ── STREAM R` block. Merge order: P lands first (replaces
`assembleDigestBody` stub), then N (adds slipped section after R's block),
then R — or whichever order CI resolves. The `// ── END STREAM R` comment
is the merge anchor for N.

### Key invariants

| Invariant | Enforced by |
|---|---|
| No LLM calls | Retrospective view is purely deterministic SQL + HTML render |
| Audit trail | Every judgement writes to `audit.access_log` |
| Valid judgements only | `RETROSPECTIVE_JUDGEMENT_VALUES` allowlist check before any DB write |
## Slipped tasks + Tuesday cohort (Stream N — PR3-N)

Stream N delivers two data-surfacing features: the Tuesday close-ready cohort
(US-025, SY-015) and slipped-task resurfacing (SY-009, SY-010).

### Tuesday close-ready cohort

`apps/web/lib/close-ready.ts` exports `getCloseReadyCohort(session)`.

A contact is **close-ready** when ALL of:
1. Has a recent touch: `crm.email_thread.last_message_at >= now() - 7 days`, OR
   `crm.call_note.occurred_at >= now() - 7 days`.
2. `crm.contact.triage_tag IN ('pilot_candidate', 'can_help_me')` (qualified).
3. No active blocker: no `pm.task` with `status IN ('blocked', 'stuck')` that
   references this contact (via the contact's email threads or call notes).
4. Not sensitive (enforced automatically by RLS on `crm.contact`).

Returns ≤10 contacts ordered by most-recent touch DESC.
Each row includes `contactId`, `contactName`, `lastTouchAt`, `lastTouchKind`
("email" or "note"), `qualifierTag`.

On Tuesdays (`new Date().getDay() === 2` as a stand-in for America/Los_Angeles),
the dashboard prepends a "Sales — close-ready" section ABOVE the "Do this first"
card. Each row has two action buttons:
- "Draft close email" → `/crm/contacts/{id}?autodraft_tone=warm-sales-followup`
- "Schedule call" → Google Calendar new-event URL (no auth required to open).

The digest (`apps/web/lib/digest-body.ts`) also adds a "Sales — close-ready"
section on Tuesdays via `buildCloseReadySection()`.

### Slipped-task resurfacing

`apps/web/lib/slipped-tasks.ts` exports `getSlippedTasks(session)`.

A task is **slipped** when ANY of:
- `due_date < current_date AND status NOT IN ('done')` → `slippedReason: "overdue"`
- `awaiting_response_until < now() AND status NOT IN ('done')` → `slippedReason: "response_overdue"`

The "response_overdue" reason implements the **"Needs check-in"** badge: the
task status is NOT changed automatically; the dashboard displays a badge so the
exec can decide to draft a check-in email.

**Hint detection**: for each slipped task, Stream N checks whether any
`crm.email_thread.subject` ILIKE-matches the first ≥6 characters of the task
title. If yes, `unblockHint: { threadId, subject }` is attached. Pure SQL — no
LLM. Stream P will replace this with richer matching if needed.

The dashboard shows:
1. A "Needs attention" banner under the header listing the slipped count.
2. Slipped tasks at the TOP of their respective swimlane (their `work_area` lane),
   styled with a red dot badge. The 5-swimlane invariant (#6) is preserved —
   slipped tasks do NOT add a 6th swimlane.

The digest adds a "Slipped this week" section via `buildSlippedSection()`.

### check-in nudge (markAwaitingResponse)

`apps/web/app/pm/projects/actions.ts` gains `markAwaitingResponse(taskId, projectId, formData)`:
- `exec_all` only.
- `formData` must carry a `date` field (YYYY-MM-DD).
- Stores `<date>T17:00:00-08:00` (5 pm PST) in `pm.task.awaiting_response_until`.
- Once the deadline passes, `getSlippedTasks` returns the task with
  `slippedReason: "response_overdue"` and the UI shows a "Needs check-in" badge.

### Digest composability

`buildSlippedSection(tasks)` and `buildCloseReadySection(contacts)` are
exported from `digest-body.ts` so Stream P can call them from the Claude-ranked
body assembler without code duplication. The O stub calls them internally via
dynamic import; P should call them directly.

### Files (Stream N)

| File | Purpose |
|---|---|
| `apps/web/lib/close-ready.ts` | `getCloseReadyCohort()` — close-ready SQL query |
| `apps/web/lib/slipped-tasks.ts` | `getSlippedTasks()` — slipped-task SQL query + hint |
| `apps/web/app/dashboard/page.tsx` | Tuesday cohort section + slipped banner + `SWIMLANE_KEYS` constant |
| `apps/web/lib/digest-body.ts` | `buildSlippedSection()` + `buildCloseReadySection()` |
| `apps/web/app/pm/projects/actions.ts` | `markAwaitingResponse()` server action |
| `apps/web/__tests__/close-ready-and-slipped.test.ts` | 12 tests including invariant #6 regression guard |

### Concurrency notes (streams P, Q)

- Stream P: do NOT replace `buildSlippedSection` / `buildCloseReadySection`
  — call them from the new ranked body function. The TODO comments in
  `digest-body.ts` explain the handoff.
- Stream Q: may add a priority-shifter banner in `dashboard/page.tsx`.
  Place it after the Stream N slipped banner, labeled `{/* Stream Q */}`.
- Stream N additions in `dashboard/page.tsx` are labeled `{/* Stream N */}`.
## Monday dashboard (PR3-L — US-017, W6.6)

The Monday "What matters this week" dashboard is a force-dynamic server component at
`/dashboard` that renders exactly **five swimlanes** every time the exec opens it.

### Lane definitions

| # | Lane name | Source | Filter |
|---|---|---|---|
| 1 | **Prospects to follow up** | `crm.contact` | `triage_tag IN ('can_help_them', 'can_help_me', 'pilot_candidate')` AND last `call_note.occurred_at > 7 days ago` (or no notes) AND `sensitive_flag IS NULL` |
| 2 | **Inbox progress** | `crm.draft` (count) + Gmail unread stub | `draft.status = 'pending'`; Gmail unread is `null` until Stream A lands `getGmailUnreadCount()`. |
| 3 | **Admin (vendors / contractors)** | `pm.task` | `work_area = 'admin'` AND `status != 'done'` |
| 4 | **Thought leadership** | `pm.task` | `work_area = 'thought_leadership'` AND `status != 'done'` |
| 5 | **Product roadmap** | `pm.task` joined `pm.project` | `work_area NOT IN ('admin', 'thought_leadership')` AND `project.project_type IN ('hire', 'deal', 'okr', 'other')` AND `status != 'done'` |

All task lanes show at most **5 items**.

### Tie-break ordering (within each task lane)

```
1. is_pinned DESC          — pinned items always at top (US-004)
2. IMPACT order:           both=1, revenue=2, reputation=3, neither=4, null=5
3. priority ASC            — lower number = higher priority
4. due_date ASC NULLS LAST — soonest due date first
```

Pinning survives across calendar weeks and is never auto-cleared (US-004).

### Empty-lane handling

Each empty lane renders a one-line prompt explaining what would populate it.
The `getDashboardLanes()` function always returns arrays; the page component owns the empty-state UI.

### Cross-cutting invariant #6

> The Monday "What matters this week" view contains exactly the five swimlanes
> the exec named — not four, not six. (user-stories.md invariant #6, US-017)

Enforced by: `apps/web/__tests__/dashboard.test.ts` (lane-count regression test).

### Stream M placeholder

`<div id="do-this-first" />` above the swimlanes is reserved for Stream M's
"Do this first" counterfactual card (US-024, SY-013). Stream M edits
`apps/web/app/dashboard/page.tsx` to fill that stub.

### Data layer

`apps/web/lib/dashboard.ts` exports `getDashboardLanes(session): Promise<DashboardLanes>`.
- All queries go through `query()` so RLS applies.
- No LLM calls — pure SQL + in-memory ordering.
- Returns `{ prospects, inbox, admin, thoughtLeadership, productRoadmap }` — always exactly 5 keys.

---

## PR3 task ergonomics — new columns (K1-K4)

Four columns added in `PR3-K` that downstream streams depend on.

| Column | Table | Type | Allowed values | Purpose | Downstream consumers |
|---|---|---|---|---|---|
| `impact` | `pm.task` | `varchar(16)` nullable | `revenue \| reputation \| both \| neither` | Exec labels each task by what it protects/grows — Monday dashboard (L) orders swimlane items by this field. | L (ordering), M (ranking input), P (digest ranking) |
| `is_pinned` | `pm.task` | `boolean not null default false` | — | Pinned tasks survive weekly resets; dashboard (L) renders them sticky-top when `is_pinned AND status != 'done'`. Unpinning is always explicit. | L (sticky-top), O (digest header) |
| `awaiting_response_until` | `pm.task` | `timestamptz` nullable | — | Date by which exec expects a reply. Stream R auto-flags tasks past this date as "Needs check-in." Added in K so all streams share the column definition. | R (auto-flag), N (slipped-task), P (digest) |
| `project_type` | `pm.project` | `varchar(16)` nullable | `sales_call \| licensing \| hire \| deal \| board_prep \| okr \| other` | Groups projects by deal/initiative type for retrospective reports and digest sections. | R (retrospective grouping), P (digest section) |

Status `stuck` added as a distinct value (previously conflated with `blocked`): `blocked` = dependency on money/human (plan exists); `stuck` = outside exec's expertise/bandwidth (no plan yet). Both appear as separate columns in the 5-column kanban.

## PR2 invariants — verified by tests + CI

Six cross-cutting properties that no PR2 commit is allowed to break. Each is enforced by at least one test and/or a CI step.

| # | Invariant | Story | Enforced by | Test / CI location |
|---|---|---|---|---|
| 1 | **Never auto-send.** No `gmail.users.messages.send` call anywhere in the codebase. | AD-004 | CI grep step (`Forbid gmail.users.messages.send` in `.github/workflows/ci.yml`) + `createGmailDraft` in `apps/web/lib/google-gmail.ts` only calls `users.drafts.create`. | CI step added in PR2-J; `apps/web/__tests__/autodraft.test.ts` (send-path rejection). |
| 2 | **Redaction before every LLM call.** Raw text never reaches the Anthropic SDK. | SY-016 | `safeAnthropic()` in `apps/web/lib/anthropic.ts` calls `redact()` before the SDK call. | `apps/web/__tests__/redaction.test.ts` (6 PII classes); `apps/web/__tests__/anthropic.test.ts` (wrapper spy). |
| 3 | **No contact-data cross-pollination.** A draft/briefing for contact A never retrieves contact B's notes/threads. | AD-008, SY-008 | `getContactContext()` in `apps/web/lib/contact-context.ts` filters all queries by `contactId` and throws on any row mismatch. | `apps/web/__tests__/cross-pollination.test.ts` (10 tests). |
| 4 | **Every LLM call produces an audit row.** `recordLlmCall()` is invoked on every Anthropic call. | SY-017 | `safeAnthropic()` calls `recordLlmCall()` unconditionally after the SDK returns. | `apps/web/__tests__/audit-llm.test.ts` (spy verifies every call path). |
| 5 | **Sensitive contacts are excluded** from search, drafts, digests, and LLM context. | US-014, AD-001, SY-008 | `crm.is_sensitive_for_role()` in `packages/db/src/rls/policies.sql`; RLS on all CRM tables. | `apps/web/__tests__/assistant-grant.test.ts` (sensitive-flag regression tests); `apps/web/__tests__/cross-pollination.test.ts`. |
| 6 | **audit.llm_call is append-only.** No UPDATE or DELETE is possible, even by superusers. | AD-005 | `BEFORE UPDATE OR DELETE` trigger `audit.llm_call_no_mutate` in `packages/db/src/rls/policies.sql` raises an exception. | Trigger installed in policies.sql (PR2-J); verified by manual migration. |

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

## Digests (Stream O — PR3-O)

Exec-db sends task-summary digest emails via **Resend** (not Gmail send; AD-004 / S6.5).
Each user opts in per cadence; both daily and weekly are off by default.

### Digest worker flow

```
Vercel Cron fires GET /api/cron/digest-daily  (14:00 UTC = 7 am America/Los_Angeles PDT)
              or GET /api/cron/digest-weekly (14:00 UTC Sundays)
  │
  ├─ Auth: Authorization: Bearer ${CRON_SECRET}  — reject 401 if missing/wrong
  │
  ├─ SELECT crm.user_pref WHERE digest_daily_optin = true  (or weekly variant)
  │
  └─ For each opted-in user → sendDigest(userId, cadence)
       │
       ├─ 1. Read crm.user_pref — skip if not opted in  (reason: not_opted_in)
       │
       ├─ 2. Resolve work_email from core.employee_dim  (skip if absent)
       │
       ├─ 3. assembleDigestBody(userId, cadence, unsubscribeToken)
       │       ← deterministic stub in PR3-O; Stream P replaces with Claude-ranked body
       │       ← Reads pm.task JOIN pm.project WHERE owner_id = userId
       │       ← daily: active tasks only (status <> 'done')
       │       ← weekly: active + completed in last 7 days
       │       ← embeds /api/digest/unsubscribe?token=<token> link
       │
       ├─ 4. sendEmailViaResend({ to, subject, html, text })
       │       ← throws on failure; cron handler records error in summary JSON
       │       ← NO gmail.users.messages.send call (AD-004 hard constraint)
       │
       └─ 5. INSERT pm.digest_send (recipient_id, cadence, task_count, body_markdown, gmail_message_id)
```

### Cron schedule

| Cron | Schedule | UTC | America/Los_Angeles |
|---|---|---|---|
| `/api/cron/digest-daily`  | `0 14 * * *`   | 14:00 UTC daily    | 7:00 am PDT (UTC-7) |
| `/api/cron/digest-weekly` | `0 14 * * 0`   | 14:00 UTC Sundays  | 7:00 am PDT (UTC-7) |

Note: During PST (UTC-8, Nov–Mar) the cron fires at 6:00 am. Adjust to `0 15 * * *`
and `0 15 * * 0` if 7 am year-round delivery is required (S5.8: single fixed TZ).

### Opt-in and unsubscribe

- `crm.user_pref` — one row per user; `digest_daily_optin` + `digest_weekly_optin`
  both default to `false` (opt-in per S5.2).
- Settings UI: `/settings/digest` — checkboxes + Save button (server action `setDigestOptin`).
- Unsubscribe: `GET /api/digest/unsubscribe?token=<unsubscribe_token>` — token-based,
  no login required. Sets both opt-ins to false and returns a plain HTML confirmation.
- Snooze is deferred (S5.7).

### Key invariants

| Invariant | Enforced by |
|---|---|
| No Gmail send | `sendEmailViaResend` uses Resend API only; CI grep blocks `gmail.users.messages.send` |
| Opt-in required | `sendDigest` checks `crm.user_pref` and returns `not_opted_in` if absent |
| Cron auth | Bearer `${CRON_SECRET}` header required; 401 on mismatch |
| Digest record | `pm.digest_send` row inserted on every successful delivery |

### Stream P — Digest content (Claude-ranked) + cadence alerts

`apps/web/lib/digest-body.ts:assembleDigestBody()` now produces a Claude-ranked body (PR3-P).

#### Digest body sections

| Order | Section | Spec |
|---|---|---|
| 1 | **Top priorities today/this week** | Top pick + up to 2 alternatives from `rankTasks()`, each with a 1-sentence reason. |
| 2 | **What I deprioritized and why** | All alternatives returned by the ranker, each with a deprioritization reason (invariant #7). |
| 3 | **Other items** | Remaining active tasks in deterministic order (not in the top-3 picks). |
| 4 | **Cadence** | Contact categories below expected touch frequency (SY-002). Only rendered when ≥1 category is short. |
| [N] | Slipped / Close-ready | Reserved for Stream N. Placeholder comments mark the composition boundary. |
| 5 | **Completed this week** | Weekly cadence only. Tasks completed in the last 7 days. |

#### Ranking data flow

```
assembleDigestBody(userId, cadence, unsubToken, session?)
  │
  ├─ SELECT pm.task JOIN pm.project WHERE owner_id = userId  (exec_all tier)
  │   RLS already excludes sensitive-flagged contacts (invariant #5, policies.sql)
  │
  ├─ rankTasks(activeTasks, session)        [apps/web/lib/ranker.ts — Stream M]
  │   └─ Single Opus call per digest; returns topPick + ≤3 alternatives with
  │      counterfactual deprioritization reasons (invariant #7).
  │      Falls back to deterministicRank() on LLM error (no digest crash).
  │
  ├─ getCadenceAlerts(session)             [apps/web/lib/cadence-alert.ts — Stream P]
  │   ├─ SELECT crm.contact WHERE owner = userId → infer category per heuristic
  │   ├─ Count touches (call_note + email_thread) per category in window
  │   └─ Return [{category, expectedPerWindow, actualCount, windowDays}] for below-target
  │
  └─ Render markdown + HTML body with all sections
```

#### Cadence alert heuristic (no explicit category column yet)

Contact category is inferred from existing fields in priority order:

| Priority | Field | Maps to |
|---|---|---|
| 1 | `sensitive_flag` IN (`vc_outreach`, `partnership`) | investor |
| 1 | `sensitive_flag` = `rolled_off_customer` | customer |
| 1 | `sensitive_flag` = `irrelevant_vendor` | contractor |
| 2 | `triage_tag` IN (`pilot_candidate`, `can_help_me`) | prospect |
| 3 | `work_area` | direct category match |

Expected cadences per W2.1:

| Category | Expected touches | Window |
|---|---|---|
| investor | ≥1 | 7 days |
| customer | ≥3 | 7 days |
| prospect | ≥1 | **14 days** (biweekly) |
| contractor | ≥3 | 7 days |
| board | ≥1 | 7 days |

TODO: Replace heuristic when a `category` column is added to `crm.contact`.

#### Key invariants (Stream P)

| Invariant | Enforced by | Test |
|---|---|---|
| Every top pick carries a counterfactual (invariant #7) | `rankTasks()` returns `alternatives[]` with `deprioritizationReason`; digest always renders "What I deprioritized" section when alternatives are present. | `digest-content.test.ts` TEST-P2 |
| Ranker called exactly once per digest | `assembleDigestBody` calls `rankTasks` once before building sections | `digest-content.test.ts` TEST-P3 |
| Cadence section only when alerts exist | Section rendered conditionally (`alerts.length > 0`) | `digest-content.test.ts` TEST-P8 |
| Prospect window = 14 days | `CATEGORY_CONFIG.prospect.windowDays = 14` | `digest-content.test.ts` TEST-P12 |
| Sensitive contacts excluded | RLS on `crm.contact` via `exec_all` session; comment in `digest-body.ts` | `assistant-grant.test.ts` (existing) |

#### Files

| File | Owner | Purpose |
|---|---|---|
| `apps/web/lib/digest-body.ts` | P | Ranked digest body assembler; imports `rankTasks` + `getCadenceAlerts` |
| `apps/web/lib/cadence-alert.ts` | P | `getCadenceAlerts(session)` → per-category alerts; `inferContactCategory()` heuristic |
| `apps/web/__tests__/digest-content.test.ts` | P | 14 tests; invariant #7 regression guard at TEST-P2 |

## Autodraft (Stream B — PR2-B)

The autodraft subsystem generates structured follow-up email drafts from call notes and email threads. The data flow enforces three invariants at every step: redaction before LLM, single-contact scope, and no auto-send.

### Data flow

```
1. User clicks "Generate follow-up" on a call note or the contact page
   │
   ▼
2. generateAutodraft(contactId, formData)  [apps/web/app/crm/contacts/actions.ts]
   │
   ├─ assertNotAutomatedOutbound()  ← scheduler-guard.ts: blocks phone & first-touch
   │
   ├─ getContactContext(contactId, session, { maxNotes:5, maxThreads:5 })
   │   └─ contact-context.ts: single-contact scope enforced; cross-pollination
   │      guard throws if any returned row has a different contact_id (AD-008)
   │
   ├─ buildAutodraftPrompt(contact, notes, threads, tone)
   │   └─ Inserts footnote markers [note:<id>] / [thread:<id>] for citation
   │
   ├─ safeAnthropic({ model, prompt, contactId, promptClass:"autodraft" })
   │   ├─ redact(prompt)  ← redaction.ts: masks PHI, PI, banking, SSN, DL,
   │   │                    non-public addresses before SDK is reached (SY-016)
   │   ├─ Anthropic SDK call (claude-sonnet-4-6 default; claude-opus-4-7 opt-in)
   │   └─ recordLlmCall(…)  ← audit-llm.ts: writes audit.llm_call + daily Sheet
   │
   ├─ Parse JSON output → { subject, body_markdown, citations }
   │
   └─ INSERT crm.draft (status="pending", promptHash=sha256(assembled-prompt) — pre-redaction; redaction itself happens inside safeAnthropic)
      ▲ NOT saved to Gmail yet — pending exec review
```

### User review

The contact detail page renders each pending draft with:
- Structured sections: Recap / Owners + dates / Next step (SY-005)
- Citation footnote chips linking back to source note/thread (SY-006)
- Tone was applied at generation time (SY-007)
- Two action buttons: "Save to Gmail Drafts" and "Discard"

### Gmail save path (with confidential-content guard)

```
User clicks "Save to Gmail Drafts"
   │
   ▼
saveDraftToGmail(draftId, contactId, formData)
   │
   ├─ assertSafeForGmail(body)  ← draft-guard.ts: scans for banking, deal-term,
   │   │                          comp, and internal-only markers (AD-003)
   │   ├─ BLOCKED → throws ConfidentialContentError(reasons[])
   │   │            UI shows warning + "I confirm this is safe" button
   │   └─ SAFE → continues
   │
   ├─ createGmailDraft(userId, { to, subject, bodyMarkdown, threadId? })
   │   └─ google-gmail.ts: users.drafts.create only — NEVER users.messages.send
   │      (AD-004 hard constraint, CI lint check)
   │
   └─ UPDATE crm.draft SET status="saved_to_gmail", gmail_draft_id=…
```

If the exec confirms confidential content is intentional, `saveDraftToGmailConfirmed`
bypasses the guard and writes an audit row to `audit.access_log` (AD-003 override
audit trail).

### Key invariants (cross-cutting)

| Invariant | Enforced by | Test |
|---|---|---|
| No auto-send | `createGmailDraft` (drafts-only) + CI lint | CI grep check |
| Redaction before LLM | `safeAnthropic` wrapper | `anthropic.test.ts` |
| No cross-pollination | `getContactContext` + runtime check | `cross-pollination.test.ts` |
| Every LLM call audited | `recordLlmCall` inside `safeAnthropic` | `audit-llm.test.ts` |
| Confidential guard | `assertSafeForGmail` before Gmail save | `autodraft.test.ts` |
| No phone/first-touch automation | `assertNotAutomatedOutbound` | `autodraft.test.ts` |

## Counterfactual ranker (Stream M — PR3-M)

The Monday "Do this first" recommendation. Cross-cutting invariant #7
(`docs/pr3-spec.md`) requires that every top pick carries a counterfactual:
the system explains what it deprioritized and why. This is the trust threshold
the exec asked for in W8.3 — without it, the suggestion is untrusted and
ignored.

### Data flow

```
1. Dashboard page loads (apps/web/app/dashboard/page.tsx)
   │
   ▼
2. SELECT pm.task WHERE owner_id = session.userId AND status != 'done'
   ORDER BY is_pinned DESC, updated_at DESC LIMIT 20
   │
   ▼
3. rankTasks(candidates, session)            [apps/web/lib/ranker.ts]
   │
   ├─ pickCandidates(): trims to ≤10. Pinned items always included
   │   (dashboard contract: pinned ≥ pick eligible).
   │
   ├─ buildPrompt(): one line per task with id, title, work_area,
   │   impact, is_pinned, due_date, priority, status. Asks for a strict
   │   JSON object: { topPick: {taskId, reason},
   │                   alternatives: [{taskId, deprioritizationReason}, …≤3] }.
   │   System prompt explicitly mentions "counterfactual" — regression-
   │   guarded by ranker.test.ts.
   │
   ├─ safeAnthropic({ model: "opus", system, prompt,
   │                  contactId: null, promptClass: "rank" })
   │   ├─ redact(prompt) — task titles can contain PII (SY-016)
   │   ├─ Anthropic SDK call (claude-opus-4-7 — correctness-critical)
   │   └─ recordLlmCall(…) — audit.llm_call row with cost (SY-017)
   │
   ├─ tryParseRanking(): strips code fences, parses JSON, drops any
   │   alternatives whose taskId isn't in the candidate set
   │   (hallucination guard).
   │
   └─ Fallback paths (any of: SDK error, JSON parse failure, hallucinated
      ids) → deterministicRank(): pinned > impact (both > revenue >
      reputation > neither > null) > priority (low number wins) >
      due_date (earlier wins) > title alphabetic.  The dashboard always
      renders SOMETHING — the trust signal is "we'd rather show a known-
      coarse fallback than crash."
```

### "I disagree" override

When the exec rejects the top pick, `disagreeWithRanker(formData)` →
`recordRankingOverride(ranking, chosenTaskId, session)` writes a single row
to `audit.access_log` with:

- `intent`: `"exec overrode ranker top pick — chose <chosen> instead of <original>; reason absent"`.
- `metadata.ranking`: the full `RankingResult` JSON, so an auditor can replay
  exactly what the exec was offered.
- `metadata.chosenTaskId` / `originalTopPickId`: explicit fields for queries.

This mirrors the `saveDraftToGmailConfirmed` audit pattern (AD-003) — the
override is non-destructive and replayable.

### Model choice

| Path | Model | Why |
|---|---|---|
| Vision check, briefing, autodraft | Sonnet | summarization + structured generation; cheap. |
| Counterfactual ranker | **Opus** | scoring + rationale must be defensible — the recommendation only ships if the exec believes it. |

### Files

| File | Owner | Purpose |
|---|---|---|
| `apps/web/lib/ranker.ts` | M | `rankTasks`, `recordRankingOverride`, `deterministicRank` |
| `apps/web/app/dashboard/page.tsx` | L (layout) + M (card) | Renders "Do this first" card; M filled L's `<div id="do-this-first" />` stub |
| `apps/web/app/dashboard/actions.ts` | M | `disagreeWithRanker` server action |
| `apps/web/__tests__/ranker.test.ts` | M | 12 tests including the invariant #7 regression guard |

## Priority shifters (Stream Q — PR3-Q)

Mid-week signals that may outrank the Monday task list: customer complaints and competitor-positioning activity detected in email (SY-014 / W8.2).

### Detection flow

```
detectPriorityShifters(session, opts?)   [apps/web/lib/priority-shifters.ts]
  │
  ├─ 1. SELECT crm.email_thread + LEFT JOIN crm.contact
  │       WHERE last_message_at >= since (default: 7 days ago)
  │       LIMIT 200 — ordered newest-first
  │
  ├─ 2. loadCustomerDomains()
  │       ├─ SELECT crm.contact.company WHERE work_area = 'customer' AND sensitive_flag IS NULL
  │       └─ SELECT core.customer_dim.domain WHERE domain IS NOT NULL
  │       → merged Set<string> (lower-cased, deduped)
  │
  └─ 3. In-process regex scan (pure regex, NO LLM call):
          ├─ customer_complaint: COMPLAINT_PATTERN matches subject+body
          │   AND contactCompany ∈ customerDomains (fuzzy: base-domain substring)
          │   → PriorityShifter { kind: "customer_complaint", … }
          │
          └─ competitor_mention: body contains COMPETITOR_DOMAINS env-var domain
              OR COMPETITOR_SWITCH_PATTERN ("we're going with" / "switched to" / "evaluating …")
              → PriorityShifter { kind: "competitor_mention", … }

  Results capped at 20, ordered newest-first.
```

### Surface points

| Surface | Condition | Behaviour |
|---|---|---|
| Dashboard banner | `detectPriorityShifters` returns ≥ 1 result | Red-border banner **above** the header and all 5 swimlanes (invariant #6 preserved — banner is outside swimlane grid). Lists count + first 3 results with kind badge, subject link, and snippet. |
| Digest email | ≥ 1 shifter in look-back window (24 h daily / 7 days weekly) | `## Priority shifts (N)` section added **after** Stream P's "Top priorities" block and **before** "Completed this week." Contains one bullet per shifter with kind label and contact link. |

### Pattern specifications

| Pattern | Regex / method | Trigger condition |
|---|---|---|
| `customer_complaint` | `/frustrated\|unacceptable\|cancel(ling\|ing\|ed\|s)?\|refund\|not working\|issue with\|complaint\|disappointed/i` | Keyword match **AND** sender domain ∈ known-customer set |
| `competitor_mention` (domain) | Plain `String.includes` | `COMPETITOR_DOMAINS` env var set + domain in body |
| `competitor_mention` (phrase) | `/we'?re going with\|switched to\|evaluating\s+\S+/i` | No env var required — fires on any of the three phrases |

### Configuration

| Env var | Default | Description |
|---|---|---|
| `COMPETITOR_DOMAINS` | `""` (empty — disabled) | Comma-separated list of competitor domain strings (e.g. `"rival.io,acme-alt.com"`). When empty, domain-based competitor detection is disabled. Phrase-based detection always runs. |

### Key invariants

| Invariant | How enforced |
|---|---|
| No LLM call | Entire detector is regex + SQL — `safeAnthropic` is never called |
| Sensitive contacts excluded | JOIN condition `AND crm.contact.sensitive_flag IS NULL` excludes sensitive contact rows |
| Invariant #6 (5 swimlanes) | Banner is rendered outside the swimlane `<section>` grid; test 9 in `priority-shifters.test.ts` guards the marker names statically |
| Results bounded | Hard `LIMIT 200` in DB fetch + `if (results.length >= 20) break` in-process |

### Files

| File | Owner | Purpose |
|---|---|---|
| `apps/web/lib/priority-shifters.ts` | Q | `detectPriorityShifters`, `parseCompetitorDomains` |
| `apps/web/app/dashboard/page.tsx` | L+M+Q | Q adds `PriorityShiftersBanner` component and concurrent detection call |
| `apps/web/lib/digest-body.ts` | O (infra) + Q (section) | Q adds `## Priority shifts` section after P's top-priorities block |
| `apps/web/__tests__/priority-shifters.test.ts` | Q | 9 tests including invariant #6 static guard |

### Concurrency notes (parallel streams N, P, Q, R)

- **Dashboard (vs N):** Q's banner is placed above the `<header>` element. Stream N adds its own section inside the swimlane area. No merge conflict expected.
- **Digest (vs P):** Q's section is bracketed by `/* BEGIN:priority-shifts */` / `/* END:priority-shifts */` sentinel comments so Stream P can reliably splice around it. Place P's "Top priorities" section **before** the `BEGIN:priority-shifts` comment.

---

## PR3 complete — all 10 streams (T)

Stream T (PR3-T) is the final cleanup stream. It re-integrated digest sections
that were reverted during parallel-merge resolution, re-enabled 4 skipped tests,
and applied high-value Copilot review feedback.

### Streams K–T: PR3 summary

| Stream | PR | Summary |
|---|---|---|
| K | #23 | Task ergonomics foundation: `impact` enum, `is_pinned`, `blocked`/`stuck` split, `project_type` enum |
| L | #27 | Monday 5-swimlane dashboard (`/dashboard`); 5-lane invariant #6 |
| M | #25 | Counterfactual ranker (`rankTasks`, Opus); "Do this first" card + "I disagree" override |
| N | #28 | Tuesday close-ready cohort + slipped-task resurfacing; `buildSlippedSection` / `buildCloseReadySection` |
| O | #24 | Digest infrastructure: Vercel Cron, Resend, opt-in `crm.user_pref`, unsubscribe link |
| P | #29 | Digest content: Claude-ranked body (`assembleDigestBody`), cadence alerts |
| Q | #30 | Priority shifters: regex + SQL detector; dashboard banner; digest `## Priority shifts` section |
| R | — | Weekly retrospective (`/retrospective`), check-in nudge badge, pending-draft digest reminder |
| S | #26 | CRM export (zip), "remember this" star on call notes, pin ops Gmail threads |
| T | — | Final cleanup: digest re-integration (R's pending-drafts + Q's priority-shifts), 4 skipped tests re-enabled, Copilot fix sweep |

### Digest section order (final)

After stream T, `assembleDigestBody` renders sections in this order:

1. Top priorities today/this week (P)
2. What I deprioritized and why (M counterfactual, via P)
3. Other items (P)
4. Cadence (P)
5. **Drafts pending review >24h** (R — re-integrated by T)
6. **Priority shifts** (Q — re-integrated by T)
7. Slipped this week (N, via dynamic import)
8. Sales — close-ready (N, Tuesdays only)
9. Completed this week (O, weekly only)

### Files added/changed by stream T

| File | Change |
|---|---|
| `apps/web/lib/digest-body.ts` | +pending-drafts section, +priority-shifts section, +`escapeMarkdown`, tier comment, `detectPriorityShifters` import |
| `apps/web/app/retrospective/actions.ts` | New — `recordRetrospectiveJudgement` server action with ownership guard |
| `apps/web/app/retrospective/page.tsx` | New — `/retrospective` weekly view; null-safe `projectId` grouping; `required` on radio inputs; removed unused imports |
| `apps/web/app/layout.tsx` | Added "Retro" nav link |
| `apps/web/lib/priority-shifters.ts` | Docstring fix; fuzzy-match minimum-length guard (`lc.length >= 4`) |
| `apps/web/__tests__/retrospective-and-checkin.test.ts` | New — 10 tests (Groups 1–4); Groups 1 and 4 re-enabled after reintegration |
| `apps/web/__tests__/priority-shifters.test.ts` | Removed unused `parseCompetitorDomains` from destructure |
| `docs/architecture.md` | This section |
| `docs/pr3-spec.md` | Done-definition status ticks |
