# Architecture

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

### Stream P handoff

`apps/web/lib/digest-body.ts:assembleDigestBody()` is a deterministic stub.
Stream P will replace it with a Claude-ranked version that:
- Weights tasks by revenue + reputation impact (S5.5 / S5.6 overrides).
- Produces counterfactual rationale ("here's what was deprioritized and why", US-024 / SY-013).
- Excludes tasks linked to sensitive contacts via `getContactContext`-style retrieval.

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
