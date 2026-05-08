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
