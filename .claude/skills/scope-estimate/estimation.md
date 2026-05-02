# Estimation rules

Deterministic line-items. Sum these — do not freeform a number.

All hour ranges are **engineering hours**, not calendar hours.

## Rate assumptions

- Senior full-stack contractor blended rate: **$150/hr** low, **$200/hr** high.
- Productive engineering hours per calendar week: **30**.
- Autonomous-agent supervision overhead: human reviews ≈ **10%** of agent
  wall-clock (PR review, prompt nudges, fixing failed steps).
- Agent token cost model (Claude Opus 4.7 mixed with Sonnet 4.6):
  - Build phase token spend: **$2.50–$5.00 per agent-hour** with prompt
    caching enabled, **$8–$15 per agent-hour** without.
  - Headline default: cached, mixed model → use **$3.50/agent-hour**.
- Autonomous agent throughput vs. human dev: agent does roughly the
  same useful work in **0.6×–1.2×** the human hours but runs unattended
  ⇒ **agent wall-clock = human-equivalent hours × 1.0** (low) to
  **× 1.5** (high) before supervision.

## PR1 — foundation

| Line item | Hours low | Hours high | Notes / driver |
|-----------|-----------|------------|----------------|
| repo cleanup, demote SaaS mirror nav | 4 | 8 | S1.5 |
| schema: contact, account, call_note, project, task | 8 | 14 | S2.1, S2.2, S4.1 |
| RLS / stub auth wiring | 4 | 12 | S7.1 (stub) vs S7.2 (real auth in PR1) |
| server actions for create/list/update | 10 | 18 | S9.7 |
| contact list + detail page | 6 | 14 | S2.4, S1.2 polish toggle |
| call-note editor (markdown) | 6 | 12 | S2.5 |
| project + task minimal UI | 8 | 16 | S4.1, S4.6 |
| seed/demo data | 2 | 4 | S9.6 |
| smoke tests | 3 | 6 | S9.5 |
| dev-env cleanup | 0 | 8 | S9.3 if unstable |
| **Adders if non-default** | | | |
| +mobile responsive | +6 | +14 | S1.4 |
| +real auth (Clerk) in PR1 | +8 | +16 | S7.1/S7.2 |
| +ownership rules + RLS | +8 | +14 | S2.9, S7.4 |
| +tags / stage / next-step on contact | +4 | +8 | S2.1 expanded |

## PR2 — Google integration + autodraft

| Line item | Hours low | Hours high | Notes |
|-----------|-----------|------------|-------|
| Google Cloud project + OAuth consent screen | 2 | 6 | S6.2 (skip if configured) |
| OAuth flow, per-user token storage (encrypted) | 8 | 14 | S6.1, S7.8 |
| Calendar read-only sync | 6 | 10 | S6.4 |
| Gmail read-only sync (snippets) | 6 | 12 | S6.6 |
| Gmail draft create (compose scope) | 4 | 8 | S3.2, S6.4 |
| autodraft generation server action | 6 | 12 | S3.1 |
| prompt + tone wiring | 4 | 8 | S3.4 |
| in-app draft review UI | 6 | 12 | S3.2 |
| sync error logging | 2 | 6 | S6.10 |
| **Adders if non-default** | | | |
| +Gmail history retrieval beyond snippet | +4 | +10 | S6.6 |
| +citations / traceability | +4 | +8 | S3.7 |
| +structured outputs (rationale, risks) | +3 | +6 | S3.8 |
| +Opus required everywhere | +0 hr but +30% token cost | | S3.10 |
| +Gmail send scope + workflow | +4 | +8 | S5.1, S6.4 |

## PR3 — PM digests

| Line item | Hours low | Hours high | Notes |
|-----------|-----------|------------|-------|
| digest query (assigned + owned) | 4 | 8 | S5.4 |
| deterministic markdown formatter | 3 | 6 | S5.6 |
| email send via Resend | 3 | 6 | S5.1 |
| Vercel Cron scheduling | 2 | 4 | S9.2 |
| opt-in / unsubscribe controls | 3 | 6 | S5.2, S5.7 |
| weekly variant | 2 | 4 | S5.3 |
| **Adders if non-default** | | | |
| +Claude-ranked priorities | +4 | +8 | S5.5 |
| +Claude-formatted digest | +3 | +6 | S5.6 |
| +per-user local TZ | +2 | +4 | S5.8 |
| +BullMQ/Redis worker | +6 | +14 | S9.1 |
| +snooze controls | +3 | +6 | S5.7 |

## Vision-check CLI

| Line item | Hours low | Hours high | Notes |
|-----------|-----------|------------|-------|
| local questionnaire → docs/vision.md | 3 | 6 | S8.2 default |
| **Adders if non-default** | | | |
| +live Claude calls | +4 | +8 | S8.2 |
| +prompt caching | +2 | +4 | S8.5 |
| +tickets/specs output | +4 | +8 | S8.6 |

## Cross-cutting

| Line item | Hours low | Hours high | Notes |
|-----------|-----------|------------|-------|
| PR specs before coding (per PR, ×3) | 6 | 12 | S10.5 |
| Audit triggers across CRM/PM | 4 | 10 | S7.6 |
| Audit log UI | 4 | 10 | S7.7 |
| Polish pass for executive dashboard | 8 | 20 | S9.8 |

## How to compute

1. Start with the per-PR base rows. Skip rows the answer eliminates
   (e.g. if S9.3 says Docker stable, drop "dev-env cleanup").
2. Add every applicable **Adders if non-default** row.
3. Add cross-cutting rows that the answers require.
4. Sum **hours low** and **hours high** independently → `H_low`, `H_high`.
5. Apply scope-creep buffer to the high end only: `H_high *= 1.30`.
6. **Cost** = `H_low * $150` to `H_high * $200`.
7. **Clock time** = `H_low / 30` to `H_high / 30` calendar weeks
   (single dev). Divide by team size if the user specifies more devs,
   then add 15% coordination tax for teams ≥ 2.
8. **Terminal time**:
   - `agent_hours_low  = H_low  * 1.0`
   - `agent_hours_high = H_high * 1.5`
   - `human_review_hours = agent_hours * 0.10`
   - `agent_token_cost = agent_hours * $3.50` (cached default) or
     `* $11` if the user disables prompt caching.
9. **Top cost drivers**: pick the 3 line items with the largest
   `(high - low)` *or* the largest absolute `high`, whichever is more
   informative. Prefer the ones tied to non-default adders.
10. **Easiest deferrals**: pick rows the user marked default-deferrable
    in §10.4, plus any adder row that costs >10 hours and is not on the
    must-have outcome path (S10.3).

## Sanity bands

Reject the estimate and ask the user to revisit answers if any of the
following hold:

- Total `H_high > 600` and budget S10.1 ≤ $40k.
- Terminal token cost > 50% of human cost — usually means caching is
  off or Opus is forced everywhere.
- Clock-time range spans more than 3× (e.g., 4–14 weeks). Tighten
  unanswered questions first.
