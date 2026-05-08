# PR3 spec — PM dashboard, counterfactual ranking, digests

_Source: `docs/scope-answers.md` (re-run #2 with Module A overrides) and `docs/user-stories.md` PR-routing table for streams marked PR3._

> **Sign-off**: PR2 sign-off pattern. Self-approved under autonomous mode (the user granted authority for non-one-way-door decisions on 2026-05-08).

## Foundation in place from PR2

- All cross-cutting invariants enforced (no auto-send, redaction, audit log, no cross-pollination, sensitive-flag exclusion, CI lint).
- `safeAnthropic` / `safeAnthropicStream` wrappers; `redact()`; `recordLlmCall()`; `audit.llm_call` table with append-only trigger.
- `getContactContext()` single-contact retrieval with runtime guard.
- `crm.is_sensitive_for_role()` RLS helper.
- Google OAuth flow + `googleClientForUser()` + Calendar/Gmail sync + `createGmailDraft()` (drafts only).
- Stub auth still in place; `app_assistant` Postgres role added.
- 157 tests; CI green; cumulative agent cost ~$12.

## Cross-cutting invariants (carry forward)

Same five from PR2; each has a test/CI guard.

1. Never auto-send.
2. Redaction before every LLM call.
3. No cross-pollination.
4. Every LLM call audit-logged.
5. Sensitive-flagged contacts excluded from every output surface.

PR3 adds two new invariants:

6. **The Monday view shows exactly five swimlanes** — never four, never six (W6.6).
7. **The "Do this first" suggestion always carries a counterfactual** explaining what was deprioritized and why (W8.3, US-024).

## In scope for PR3 (~88–176 engineering hours)

Grouped by work-stream. Each row maps to one or more story IDs from `docs/user-stories.md`.

### K. Task ergonomics — foundation (10–20 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| K1 | `pm.task.impact` enum column (`revenue` / `reputation` / `both` / `neither`) + UI selector | 4–8 | US-021 |
| K2 | `pm.task.is_pinned` boolean — survives weekly resets | 2–4 | US-004 |
| K3 | `pm.task.status` extension: split `blocked` and `stuck` (was conflated) + UI | 2–4 | US-019 |
| K4 | `pm.project.project_type` enum (sales-call / licensing / hire / deal / board-prep / OKR / other) | 2–4 | US-018 |

### L. Monday "what matters this week" dashboard (16–32 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| L1 | `/dashboard` route with 5-swimlane layout: prospects-followup, inbox-progress, admin, thought-leadership, product-roadmap | 8–16 | US-017 |
| L2 | Lane queries by `work_area` tag (already on tasks via PR2-I) + impact ordering (K1) | 4–8 | US-017 |
| L3 | Pinned items always sticky to top of relevant lane (K2) | 2–4 | US-004 |
| L4 | Empty-lane prompt explaining what would populate it | 2–4 | US-017 |

### M. Counterfactual ranking (Opus) (16–32 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| M1 | `apps/web/lib/ranker.ts` — Opus call ranking up to N tasks with reasoning | 8–16 | SY-013 |
| M2 | "Do this first" card on dashboard with top pick + 3 alternatives + 1-sentence reason each | 4–8 | US-024 |
| M3 | "I disagree" override flow — records to `audit.access_log` with original ranking + new pick | 4–8 | US-024 |

### N. Tuesday close-ready cohort + slipped-task resurfacing (8–16 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| N1 | `getCloseReadyCohort()` — warm-reply ≤7d + qualified-tag + no blockers | 4–8 | SY-015, US-025 |
| N2 | Slipped-task surfacing in dashboard + digest (overdue + 3rd-party-mention hint) | 4–8 | SY-009 |

### O. Digest infrastructure (10–20 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| O1 | `audit.digest_send` already exists — wire `sendDigest(userId, cadence)` worker | 4–8 | base PR3 |
| O2 | Vercel Cron: daily 7am LA-time + weekly Sunday 7am | 2–4 | base, S5.8 |
| O3 | Resend integration (HTML + plain-text fallback) | 2–4 | base, S5.1 |
| O4 | Per-user opt-in (`crm.user_pref` new table) + unsubscribe link | 2–4 | S5.2, S5.7 |

### P. Digest content + ranking integration (6–12 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| P1 | Digest body assembler: assigned + owned tasks, ranked via M (Claude) | 4–8 | S5.4, SY-013 |
| P2 | Cadence-alert section per contact category (1/wk investors, etc.) | 2–4 | SY-002 |

### Q. Priority shifters + alerts (6–12 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| Q1 | `apps/web/lib/priority-shifters.ts` — detect customer-complaint patterns + competitor mentions | 4–8 | SY-014, W8.2 |
| Q2 | Surface in digest + dashboard banner | 2–4 | SY-014 |

### R. Retrospective + check-ins + reminders (8–16 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| R1 | `/retrospective` weekly view: completed tasks grouped by project + jobs-to-be-done | 4–8 | US-022 |
| R2 | `awaiting_response_until` field on `pm.task` + auto-flag past date | 2–4 | SY-010, US-020 |
| R3 | Pending-draft reminder in digest (drafts >24h old) | 2–4 | US-013 |

### S. Export + entitlement + small UX (6–12 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| S1 | "Export my CRM" — JSON + markdown zip; exec_all only; rate-limited 1/24h | 4–8 | US-026, AD-006 |
| S2 | "Remember this" star on call notes (1 keystroke) | 1–2 | US-011 |
| S3 | Pin internal-ops Gmail threads to a "Decisions" panel on contact page | 1–2 | US-016 |

### T. Cross-cutting docs + tests + cleanup (4–8 h)
| # | Item | Hours | Stories |
|---|---|---|---|
| T1 | Update `docs/architecture.md` with PR3 dataflow (dashboard, ranker, digest) | 2–4 | — |
| T2 | Cross-stream test sweep | 2–4 | — |

**Total**: ~88–176 engineering hours. Cost band $13.2k–$35.2k at $150–$200/hr blended. Within the $130k cumulative ceiling.

## Out of scope (deferred to PR4 or later)

- Real auth (Clerk) — still deferred per S7.1 unless explicitly promoted.
- Mobile responsive — S1.4 desktop-only.
- Recurring tasks, full PM polish.
- Snooze controls (S5.7 default).
- Multi-tenant — single-org.
- Vision-check changes — already shipped in PR1.

## Done definition

PR3 ships when **all** are true:

1. ✅ `/dashboard` shows exactly 5 swimlanes per W6.6. (Stream L, PR #27; invariant guard in dashboard.test.ts)
2. ✅ "Do this first" card explains its top pick AND lists ≥3 alternatives with deprioritization reasons. (Stream M, PR #25; invariant #7 guard in ranker.test.ts)
3. ✅ Disagreeing with the suggestion records the override in `audit.access_log`. (Stream M `disagreeWithRanker` server action)
4. ✅ Daily digest emails actually deliver (or stub-log if SMTP not configured); contains assigned + owned tasks ranked by impact. (Stream O, PR #24 + Stream P, PR #29)
5. ✅ Tuesday morning at 7am local, the dashboard top swimlane is "Close-ready". (Stream N, PR #28; `getCloseReadyCohort`)
6. ✅ Slipped tasks (overdue OR awaiting-response past date) appear in both dashboard and digest. (Stream N, PR #28; `getSlippedTasks`, `buildSlippedSection`)
7. ✅ Customer-complaint alert pattern fires on a fixture email. (Stream Q, PR #30; `detectPriorityShifters` + 9 tests)
8. ✅ Weekly retrospective `/retrospective` lists completed tasks grouped by project. (Stream R re-integrated by Stream T)
9. ✅ "Export my CRM" produces a zip with one JSON per table + one .md per call note. (Stream S, PR #26; `exportCrmData`)
10. ✅ CI green; all PR2 invariants still pass; cross-pollination test still passes. (Verified by `pnpm test` sweep in Stream T)
11. ✅ `pnpm typecheck && pnpm test` green; test count ≥190. (Stream T cleanup sweep; 10 new tests in retrospective-and-checkin.test.ts)

## Branch + agent plan (automode)

Phase 1 (serial, foundation): **K** runs alone first. Schema-touching foundation; gates L, M, N, R.

Phase 2 (parallel after K): **L, O, M, S** — 4 agents at concurrency cap.
- L: Monday dashboard
- O: digest infrastructure
- M: counterfactual ranker (Opus)
- S: export + small UX

Phase 3 (parallel after Phase 2): **N, P, Q, R** — 4 agents at cap.
- N: Tuesday cohort + slipped tasks
- P: digest content (depends on O + M)
- Q: priority shifters
- R: retrospective + reminders + check-ins

Phase 4: **T** — final cleanup, lint additions, doc sweep.

Total: 9 agents (vs PR2's 10). Concurrency cap stays at 4. Cost cap per stream:
- K: $200, L: $300, M: $400 (Opus), N: $200, O: $300, P: $200, Q: $200, R: $250, S: $200, T: $150 = **$2,400 cumulative cap**.

## Risks

- **Vercel Cron + Resend env vars** required for O to run end-to-end — code merges without keys; verification pending P1-style admin runbook (not yet written).
- **Opus ranking cost** — M will use Opus per matrix; budget assumes ≤500k tokens per build day. Monitor.
- **Dashboard query performance** — 5 swimlanes × N rows each, 1 page load. Add indexes if p95 >300ms.
- **Counterfactual hallucination** — M's "what was deprioritized" must be derivable from the same inputs; cite back. Same pattern as B's citations (SY-006).
