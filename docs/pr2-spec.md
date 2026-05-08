# PR2 spec — Google + autodraft + safety rails

_Source of truth for in-scope/out-of-scope. Derived from `docs/scope-answers.md` (re-run #2 with Module A overrides) and `docs/user-stories.md` (must-priority items routed to PR2)._

> **Sign-off gate.** No code lands on `claude/pr2-*` branches until the user reviews this spec and either approves it as-is, asks for trims, or asks for adds. Same gate model as PR1.

## Foundation in place from PR1

- `crm.contact`, `crm.account`, `crm.call_note`, `crm.draft`, `crm.calendar_event`, `crm.email_thread` schemas (PR1 #5).
- `pm.project`, `pm.task`, `pm.task_dependency`, `pm.digest_send` schemas.
- RLS roles `app_runtime`, `app_exec`, `app_function_lead`, `app_manager`, `app_employee`; full crm/pm/audit policies.
- `withSession` RLS-context wrapper, `query` helper, RBAC types.
- Server actions: `createContact`, `addCallNote`, `updateCallNote` (24h window), `discardDraft`, `createProject`, `createTask`, `updateTaskStatus`.
- Markdown renderer (`apps/web/lib/markdown.ts` — marked + sanitize-html).
- 14 vitest smoke tests, vitest config with `@/` alias.
- CI: `typecheck + test` on push and PR (`.github/workflows/ci.yml`).
- Stub auth (Phase 0). **Stays as stub through PR2.** Real auth (Clerk) deferred to PR3 unless promoted.

## Hard prerequisites (outside dev scope)

These block the first commit on a PR2 branch and must be done by an admin first.

| # | Prereq | Owner | Notes |
|---|---|---|---|
| P1 | Create GCP project; enable Calendar API + Gmail API | Admin | ~30 min |
| P2 | Configure OAuth consent screen (internal Workspace; scopes: Calendar.readonly, Gmail.readonly, Gmail.compose) | Admin | ~30 min |
| P3 | Create OAuth client credentials; drop client_id + client_secret into `.env` | Admin | ~10 min |
| P4 | Create a Google Sheet for the LLM prompt audit log; share write access to a service-account email | Admin | ~15 min, gates SY-017 |
| P5 | `ANTHROPIC_API_KEY` set with billing enabled (already done for PR1 vision-check) | Admin | done |

S6.2 default ("assume not configured") budgets 2–6 h for the dev to *help with* P1–P3, but the actual setup is admin clicks in console.

## Cross-cutting invariants this PR enforces

These are the engineering-testable properties pulled from `docs/user-stories.md`. Each has a test that lands in this PR and runs in CI.

1. **Never auto-send.** No `gmail.users.messages.send` import anywhere in the codebase. CI lint check (AD-004).
2. **Redaction filter runs before every LLM call.** Deterministic, unit-tested across 6 PII classes (SY-016).
3. **No contact data crosses contact boundaries.** Integration test: a draft generated for contact A never retrieves contact B's notes/threads (AD-008, SY-008).
4. **Every LLM call produces an audit-log row.** Vitest spy verifies the log writer is invoked on every Anthropic call (SY-017).
5. **Sensitive-flagged contacts are excluded** from search, drafts-for-others, digests, and LLM context. Tests for each surface (US-014, AD-001).

## In scope for PR2 (~145–292 engineering hours)

Grouped by work-stream. Hours match `docs/scope-answers.md` re-run #2 line items. Each row maps to one or more story IDs.

### A. Google integration (28–58 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| A1 | OAuth flow (per-user consent), encrypted token storage in `crm.oauth_token` (pgcrypto) | 8–14 | S6.1, S7.8, AD-007 |
| A2 | Calendar read-only sync worker → `crm.calendar_event` | 6–10 | S6.4, S6.7 |
| A3 | Gmail read-only sync (**full thread bodies — override S6.6**) → `crm.email_thread` + body table | 10–22 | S6.6 override, W2.4 |
| A4 | Gmail draft create (compose scope only) | 4–8 | S3.2, S6.4 |

### B. Autodraft (37–70 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| B1 | Autodraft generation server action (Sonnet by default; Opus opt-in per draft) | 6–12 | S3.10, US-012 |
| B2 | Prompt + tone wiring with per-draft selector (founder-concise / formal / warm) | 4–8 | S3.4, SY-007 |
| B3 | **Structured drafts** — Recap / Owners + dates / Next step (override S3.8) | 3–6 | SY-005, W4.1 |
| B4 | **Citations** to source notes/threads (override S3.7) | 4–8 | SY-006, W4.4 |
| B5 | In-app draft review UI (markdown + citation footnotes; "Save to Gmail Drafts" button) | 6–12 | S3.2, US-012 |
| B6 | One-click "Generate follow-up" on call-note + contact pages | 6–12 | US-012 |
| B7 | Sync error logging (logs only, no UI per S6.10) | 2–6 | S6.10 |
| B8 | "Never auto-call / never first-touch auto-reply" guards in scheduler | 1–2 | SY-011, W7.3 |

### C. Sensitive-flag + cross-pollination guard (12–24 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| C1 | `crm.contact.sensitive_flag` enum column + AD-001 taxonomy {rolled-off-customer, irrelevant-vendor, acquisition-target, LOI, VC-outreach, partnership} + UI toggle | 4–8 | AD-001, US-014 |
| C2 | Context retrieval scoped strictly to one contact at a time; never cross-link without explicit user action | 4–8 | SY-008 |
| C3 | Integration test proving cross-pollination cannot happen across refactors | 4–8 | AD-008 |

### D. Redaction filter (16–32 h, **gates everything else in B**)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| D1 | `apps/web/lib/redaction.ts` — deterministic regex + tokenizer for PHI, PI, banking, names, SSN, driver licenses, non-public business addresses/emails | 10–20 | SY-016, W10.4 |
| D2 | Vitest covering each redaction class with positive + negative cases | 4–8 | SY-016 |
| D3 | Wrap every Anthropic call site so raw text cannot reach the SDK | 2–4 | SY-016 |

### E. LLM audit log (10–20 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| E1 | `audit.llm_call` table + `recordLlmCall(contactId, model, promptClass, redactedHash, responseHash, tokens, costUsd)` helper | 4–8 | SY-017 |
| E2 | Daily Google Sheet appender via service account; one row per call | 4–8 | SY-017, P4 |
| E3 | 365-day retention policy doc + a no-op delete-prevention check in CI | 2–4 | AD-005 |

### F. Pre-call briefing (16–32 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| F1 | Briefing assembler: last 3 notes + last 5 thread subjects + current title/company + public-perspective links | 8–16 | US-006, SY-003 |
| F2 | "Briefing" panel on contact detail; cached, <2 s render; live fetches in background | 6–12 | US-006 |
| F3 | Empty-state handling ("—" not "loading forever") | 2–4 | US-006 |

### G. Quick-add + auto-create (16–32 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| G1 | Paste LinkedIn URL → parse → draft contact (`status=needs_review`) | 4–8 | US-005 |
| G2 | Forwarded email intake address → parse From + signature → draft contact | 8–16 | US-005, SY-001 |
| G3 | Dedup by primary_email; never overwrite an exec-confirmed record | 2–4 | SY-001 |
| G4 | "Confirm draft" UI on the contact list | 2–4 | US-005 |

### H. Assistant role + function-lead read (8–16 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| H1 | New `app_assistant` Postgres role; extend RLS policies on `crm.*` and `pm.*` for read; sensitive-flag still hides from this role | 4–8 | AD-002, US-023 |
| H2 | Invite-assistant UI + share-with-assistant flow | 4–8 | US-023 |

### I. Triage + search + work-area tags (12–24 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| I1 | `crm.contact.triage_tag` (can-help-them / can-help-me / pilot-candidate); filter in contact list | 4–8 | US-007, W2.5 |
| I2 | Full-text search across call notes; sensitive contacts excluded by default with toggle | 8–16 | US-008, W3.6 |
| I3 | `work_area` tag enum on contacts and tasks (prospecting / customer / investor / contractor / board / thought-leadership / admin) | 1–2 | US-001 |

### J. Cross-cutting + tests (8–16 h)

| # | Item | Hours | Stories / S-ids |
|---|---|---|---|
| J1 | This spec; PR2 description + decision log | 2–4 | S10.5 |
| J2 | Update `docs/architecture.md` for OAuth flow + redaction + audit log | 2–4 | — |
| J3 | Update `docs/access-control.md` for `app_assistant` role | 1–2 | AD-002 |
| J4 | CI lint check forbidding `gmail.users.messages.send` | 1–2 | AD-004 |
| J5 | New vitest cases for every new server action (≥1 per action) | 2–4 | S9.5 |

**Total**: 145–292 engineering hours. Cost band $21.75k–$58.4k at $150–$200/hr. Within the $130k ceiling (S10.1 override).

## Out of scope (going to PR3)

These are on the routing table but not in PR2:

- **PM dashboard work**: US-017 Monday 5-swimlane, US-021 impact tag, US-024 + SY-013 counterfactual ranking, US-025 Tuesday close-ready cohort.
- **Digest infrastructure**: SY-002 cadence alerts, SY-009 slipped-task resurfacing, SY-014 priority shifters, SY-015 Tuesday cohort.
- **Retrospective + score**: US-022 weekly retro.
- **Pinning + reminders**: US-004 high-regret pinning, US-013 pending-draft reminder, US-016 pin ops threads, US-020 awaiting-response check-in.
- **Project + task polish**: US-018 project type taxonomy, US-019 blocked vs stuck.
- **Should-priority "could fit but won't"**: US-002 inbox-zero indicator, US-010 note templates, US-011 "remember this" tag, SY-004 action extraction, SY-012 funnel monitoring, AD-006 export entitlement.
- **Real auth (Clerk)** — still deferred to PR3 unless explicitly promoted.
- **Mobile responsive** — S1.4 desktop-only.

## Done definition

PR2 ships when **all** of the following are true:

_Status updated by stream J (2026-05-08). Streams D, C, E, A, F, G, B, H merged; stream I not merged to main (cherry-picked into J)._

1. [x] Admin can complete OAuth consent for their Workspace; tokens are stored encrypted; refresh works. _(Stream A — PR #15)_
2. [x] Calendar events and Gmail threads (full body) for connected accounts populate the contact detail page. _(Stream A — PR #15)_
3. [x] Pre-call briefing renders for any contact within 2 s on cached data. _(Stream F — PR #16)_
4. [x] "Generate follow-up" on a call note produces a structured Gmail Draft (Recap / Owners + dates / Next step) with citations to source notes/threads. **Never sent.** _(Stream B — PR #18)_
5. [x] Marking a contact `sensitive` excludes it from drafts-for-others, search, and any LLM context. Cross-pollination integration test passes. _(Stream C — PR #13; H — PR #19)_
6. [x] **Every** LLM call passes through redaction first; vitest covers all 6 PII classes; integration test asserts no raw call escapes the wrapper. _(Stream D — PR #12; B — PR #18)_
7. [x] **Every** LLM call writes a row to `audit.llm_call` and to the daily Google Sheet. _(Stream E — PR #14; B — PR #18)_
8. [x] CI lint blocks any new `gmail.users.messages.send` import. Existing CI (`typecheck + test`) is green. _(Stream J — this PR; `.github/workflows/ci.yml`)_
9. [x] Assistant role can sign in (stub auth via assistant tier) and read CRM/PM with sensitive contacts hidden. _(Stream H — PR #19)_
10. [x] Quick-add a LinkedIn URL → draft contact in <30 s. Forwarded email at intake address → draft contact in <2 min. _(Stream G — PR #17)_
11. [x] `pnpm typecheck && pnpm test` are green; vitest count up by ≥10. _(All streams; ≥160 tests in suite as of J)_
12. [x] `docs/architecture.md` and `docs/access-control.md` updated. _(Stream J — this PR)_

**Deferred to PR3**: Real auth (Clerk), triage/work-area search UI (stream I full-text search page `/crm/search` not merged), PM dashboard work, digest infrastructure, retrospective + score, pinning + reminders. Filter chips and schema columns from stream I were restored in stream J. Full-text search page (`/crm/search`) not restored — deferred to PR3 as it is not part of J's blast radius.

## Branch + PR plan

- **Branch**: `claude/pr2-foundation` (mirrors PR1 naming).
- **Commit cadence**: one commit per **work-stream letter** (A–J), each runnable on its own. ~10 commits expected.
- **Commit order** (dependencies dictate):
  1. **D** redaction filter (gates everything in B/F/G/H — must land first).
  2. **E** audit log helper (also gates LLM calls).
  3. **A** Google integration (OAuth + Calendar + Gmail full-body sync).
  4. **C** sensitive-flag + cross-pollination guard.
  5. **B** autodraft (depends on D, E, A, C).
  6. **F** pre-call briefing (depends on A).
  7. **G** quick-add / auto-create.
  8. **H** assistant role.
  9. **I** triage + search + tags.
  10. **J** docs + lint + tests pass.
- **PR title**: `PR2: Google + autodraft + safety rails`.
- **PR description**: derives from this spec; lists work-stream completion checkmarks against the Done definition.
- **Squash merge** on approval. CI must be green.

## Risks

- **Redaction filter false negatives.** Regex-based filters miss creative phrasings (e.g., "my account is one-two-three"). Mitigate with a deny-by-default mode for any pattern flagged by a secondary lightweight LLM check on the redacted output, gated behind a feature flag for opt-in tightening later.
- **Gmail full-body sync at scale.** Pulling full message bodies for active contacts will exceed the snippet quota fast. Batch + rate-limit, prefer sync-on-open over bulk for contacts the exec hasn't touched in 30 days.
- **OAuth refresh-token rot.** Google refresh tokens can expire if a user revokes; need a "reconnect" flow visible to the exec. PR2 ships the flow but the reconnect UI is minimal.
- **GCP quota for the audit Sheet.** Daily appends are fine at this volume but watch for rate limits if the prompt count spikes.
- **Sonnet → Opus drift.** Default Sonnet for cost; Opus opt-in per draft. If exec routes everything to Opus, costs jump 4–5×; budget impact tracked in the prompt audit log.
- **Two-Gmail-account complexity.** Personal account is "of record" only for reading; CRM writes always go to professional. UX needs a clear "from-account" badge to avoid confusion.

## Sign-off

Before any code lands on `claude/pr2-foundation`:

- [x] **User confirms scope** — accepted as-is on 2026-05-08.
- [ ] Hard prereqs P1–P4 are complete (admin work — runs `docs/pr2-prereqs-runbook.md`).
- [x] **Initial commit order** — default accepted: D → E → A → C → B → F → G → H → I → J.

Code starts on `claude/pr2-foundation` once the prereqs checkbox flips to `[x]`.
