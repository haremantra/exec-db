# PR4 spec — deferred should/could items + week-1 signal response

_Source: `docs/user-stories.md` PR-routing table (should/could rows not in PR2/PR3), the feedback scratchpad's decision-gate table, and the principal's 15 MVP answers from session 2026-05-12._

> **Sign-off**: orchestrator self-approved under autonomous mode. Real-world feedback from PR1–PR3 use will trigger re-scoping at the PR4/PR5 boundary.

## Foundation now on main (post-PR1+PR2+PR3 + follow-up targets)

- 7 cross-cutting invariants test-enforced (no auto-send, redaction, audit log, no cross-pollination, sensitive-flag exclusion, 5-swimlane Monday view, counterfactual ranking).
- 343 tests passing in CI; `typecheck + test` gated on every PR.
- Operational: PR2 + PR3 prereqs runbooks, deploy go/no-go checklist, runbook audit report, `pnpm bootstrap` CLI.
- Follow-up targets just landed: Vercel base64 service-account fix, `/metrics` page, daily Anthropic cost guardrails ($5/day cap), Clerk authentication (stub fallback gated on `AUTH_PROVIDER=stub`).
- 26 agents run; ~$40 cumulative LLM spend across the entire build.

## Cross-cutting invariants (still in effect)

Identical to PR3. PR4 adds one new candidate invariant:

8. **Stub auth never reaches production** — `AUTH_PROVIDER=stub` returns null in production regardless. Already implemented; PR4 adds a CI lint to prevent reintroducing the bypass.

## In scope for PR4 (~40–80 engineering hours)

Smaller than PR2/PR3 because the foundation already supports most of these as additions.

### AA. Should-priority surfaces (16–32 h)

| # | Item | Hours | Stories |
|---|---|---|---|
| AA1 | US-002 inbox-zero indicator on dashboard (Gmail unread count) | 4–8 | US-002 |
| AA2 | US-010 call-note templates (Opportunities / Friction / Tasks) | 4–8 | US-010 |
| AA3 | US-018 + project comments/activity stream | 4–8 | US-018, S4.3 |
| AA4 | US-019 better blocked-vs-stuck status differentiation in UI (currently the columns exist; this polishes the visual + adds a "what unblocks this?" prompt) | 4–8 | US-019 |

### BB. Could-priority quality-of-life (8–16 h)

| # | Item | Hours | Stories |
|---|---|---|---|
| BB1 | US-003 weekly meeting load chart on dashboard | 2–4 | US-003 |
| BB2 | US-016 deepen "pin internal-ops thread" — add a Decisions tab | 2–4 | US-016 |
| BB3 | SY-004 action extraction from call notes via Claude (Sonnet) | 4–8 | SY-004 |

### CC. Operational hardening (8–16 h)

| # | Item | Hours | Notes |
|---|---|---|---|
| CC1 | CI lint: forbid `AUTH_PROVIDER=stub` in production deploys | 2–4 | New invariant #8 |
| CC2 | Monthly audit-log rotation cron (drops or archives `audit.llm_call` rows older than 365 days) | 2–4 | AD-005 retention |
| CC3 | Health-check endpoint + alerting on missed Vercel cron runs | 4–8 | Failure-signal coverage |

### DD. Telemetry instrumentation for the not-yet-measurable signals (8–16 h)

| # | Item | Hours | Notes |
|---|---|---|---|
| DD1 | `crm.call_note.intended_followup` boolean + `acted_on_at` timestamp; surface "% follow-ups sent within 24h" on `/metrics` | 3–6 | Closes scratchpad row "% follow-ups in 24h" |
| DD2 | Poll Gmail Sent folder for the draft's message ID; compute edit-distance between draft and sent body | 5–10 | Closes scratchpad row "edit-distance" |

## Out of scope (deferred to PR5 or shelved)

- **Mobile responsive** — principal said shelved permanently.
- **Recurring tasks** — speculative until real PM use surfaces the need.
- **Snooze controls on digests** — low value at 1-user audience.
- **Multi-tenant** — single-org only.
- **WorkOS / SAML SSO** — Clerk's built-in SAML is sufficient until ≥10 users.
- **Vision-check expansion** — shipped in PR1; no improvements scheduled.
- **PR-spec lint** (verifying PR descriptions list expected story IDs) — nice-to-have, no current cost.

## Done definition

PR4 ships when **all** are true:

1. Inbox-zero indicator renders on `/dashboard` showing actual Gmail unread count from the connected of-record account.
2. Call-note templates appear as a one-click option on the call-note form; selecting one pre-fills `## Opportunities / ## Friction / ## Tasks` headings.
3. Project comments are addable, deletable (24h window for author), and surfaced in a per-project activity stream.
4. Blocked vs stuck columns each display a one-line "next action to unblock" text the exec can edit.
5. CI lint catches any code path that exposes the stub auth in production (`process.env.NODE_ENV === "production"` gate on every stub branch).
6. Audit log rotation cron is wired to Vercel; old rows go to `audit.llm_call_archive` or are deleted per `RETENTION_DAYS` env var.
7. `pnpm typecheck && pnpm test` green; test count ≥380.
8. Cumulative budget spent on agents for PR4 < $400 (3-stream parallel pattern from PR3).

## Branch + agent plan (automode)

Per the orchestrator-build-model phases:

- **Phase 1 (discovery)**: skipped — we already have user stories.
- **Phase 2 (specification)**: this document.
- **Phase 3 (foundation)**: none required — all PR4 items add to existing schemas.
- **Phase 4 (parallel fan-out)**: 3 concurrent streams.
  - **AA**: should-priority surfaces (dashboard + note templates + project comments + blocked/stuck polish)
  - **BB**: quality-of-life (meeting chart + Decisions tab + action extraction)
  - **CC + DD combined**: operational hardening + telemetry instrumentation (CI lint, rotation cron, intended_followup column, edit-distance poll)
- **Phase 5 (cleanup)**: integration agent for any conflicts on shared files (mostly `dashboard/page.tsx` and `digest-body.ts`).
- **Phase 6 (operationalization)**: short doc update; no new runbook needed.

Estimated cost: 3 parallel agents × $200 + 1 cleanup at $150 = **$750 cap**.

## When to start

**Wait 1–2 weeks for real-world signal first.** The feedback scratchpad's decision-gates table determines which PR4 items survive contact with reality. Specifically:

- If exec never opens `/dashboard` after week 2 → drop AA1 (inbox-zero indicator is dashboard-bound).
- If autodraft save-rate is <60% → reprioritize toward better drafts before AA2 (templates won't help if drafts themselves are wrong).
- If sensitive-flag activations are 0 after 30 days → drop the "stub never reaches production" CI lint (no one to leak data to).
- If exec wants the assistant role active → promote US-023 wiring (already built in PR2-H) above any PR4 item.

## Risks

- **Tier expansion** — adding Clerk made it trivial to invite users. If the principal grants `exec_all` to multiple people before the assistant role is exercised in real flows, sensitive-flag exclusion still holds but the audit-log volume grows ~Nx. Cost guardrails ($5/day) catch this within 24h.
- **AA3 project comments scope creep** — comments are easy to design wrong. Lock down: no nesting, no @mentions, no notifications. Just append-only text with an author and timestamp. Anything else gets a follow-up PR.
- **DD2 edit-distance polling Gmail Sent** — depends on the user signing into Gmail and having the of-record token still valid. Will break silently if the token rots. Mitigate by falling back to "no edit-distance available" and logging once per failure (not every poll).
