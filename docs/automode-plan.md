# Automode plan — batch agents for PR2 and PR3

Multi-agent execution plan for PR2 (and PR3 by extension) using the
distributed-systems patterns: serial gates, bulkheads, backpressure,
single source of truth, observable runs, hard cost caps.

Status: **approved 2026-05-08**. Live document — update after each stage gate.

## Goals & non-goals

**Goals**
- Cut PR2 wall-clock from 8–21 weeks (sequential) to 3–6 weeks via parallel agents.
- Preserve PR-per-stream cadence and the CI gate.
- Preserve cross-cutting invariants (no auto-send, redaction-before-LLM, no cross-pollination, audit-log-every-call).
- Bound human review at ~10% of agent wall-clock.

**Non-goals**
- Lights-out automation. Every PR still squashes through human approval.
- Replacing spec/sign-off gates. Agents implement spec; agents do not write spec.
- Cross-PR refactors. Each agent stays inside one work-stream's blast radius.

## Topology

```
                   ┌── D redaction ──┐
        ┌──────────┤                 │
        │          └── E audit log ──┤
        │                            │
        │       ┌── A Google ────────┼── B autodraft ──┐
        │       │                    │                 │
        │       │          ┌── C sensitive flag ───────┤
        │       │          │                           │
[sequential serial]        ├── F briefing ─────────────┤
                           ├── G quick-add ────────────┤
                           ├── H assistant role ───────┤
                           └── I tags + search ────────┤
                                                       │
                                              [J docs + lint + tests]
```

- **Phase 1 (serial)**: D → E → A → C. Each gates downstream invariants.
- **Phase 2 (parallel)**: B, F, G, H, I. Disjoint files; cap at 4 concurrent.
- **Phase 3 (serial)**: J — docs, CI lint, integration tests.

## Coordination protocol — single source of truth

Agents read append-only state, write only to their own branch.

| Read-only canonical state | Who writes it | When |
|---|---|---|
| `docs/pr2-spec.md` | Human | Spec sign-off; stable thereafter |
| `docs/user-stories.md` | Human | Module A re-run only |
| `docs/scope-answers.md` | Human | Module B re-run only |
| `main` branch | Squash-merge from approved PR | Per-stream merge |

**No agent reads another agent's in-flight branch.** Cross-stream
dependencies handshake via merged PRs only. Equivalent of "no
read-your-own-writes shortcuts across services."

## Bulkheads (isolation)

Each agent runs in an isolated **git worktree** via the Agent tool's
`isolation: "worktree"` flag.

```
~/code/exec-db                       (mainline; clean)
  /.claude/worktrees/                (gitignored — see .gitignore)
    pr2-D-redaction/                 (agent D)
    pr2-E-audit-log/                 (agent E)
    pr2-A-google/                    (agent A)
    pr2-B-autodraft/                 (agent B, Phase 2)
    ...
```

Stuck or off-spec agent ⇒ blow away the worktree. Mainline +
other agents untouched.

## Backpressure

**Concurrency cap: 4 agents in Phase 2.** Even with 5 disjoint
streams, human review absorbs ~4 PRs/day. More than that ⇒ review
becomes the bottleneck and the system regresses to sequential.

Queue policy: FIFO by stream-letter. If 5+ eligible, hold one until
a slot frees.

## Health checks (per-PR)

Each agent's PR must pass three gates before mergeable:

1. **CI green** — `typecheck + test` on the PR head.
2. **Spec adherence** — PR body lists every story ID it claims to
   satisfy; CI lint (J5 in the spec) verifies only PR2-routed IDs
   appear in commits/messages on that branch.
3. **Invariant tests** — every Phase 2 PR includes the integration
   test that proves its slice of the cross-pollination/redaction/
   audit-log invariant doesn't regress.

Failure of any gate ⇒ no merge.

## Observability — agent run log

Reuse the SY-017 audit-log Google Sheet. One row per agent run:

| run_id | agent | stream | start | end | wall_hours | tokens | $cost | outcome | PR |
|---|---|---|---|---|---|---|---|---|---|
| _example_ | sonnet | D | 2026-05-08T14:00Z | 2026-05-08T18:12Z | 4.2 | 580k | $14.20 | merged | #11 |

Same invariant the product enforces (every LLM call observable),
applied to the build itself.

## Failure handling

| Failure mode | Detection | Response |
|---|---|---|
| Agent stuck | Wall-clock > 2× est high or tokens > 2× budget | Kill + replan with sharper prompt |
| Off-spec | CI lint fails; PR diff outside stream files | Reject PR; rerun with explicit allowlist |
| Merge conflict on `main` | Git reports conflict | Last-PR-loses; rebase + retry; if conflict touches spec, escalate |
| Invariant regression | Phase 2 cross-pollination/redaction test fails | Hard block; treat as Sev-1 |
| Cost overrun | Single run > $50 | Auto-kill; require explicit approval to retry |
| Green CI but wrong feature | Human review during merge | Reject; rerun. CI necessary not sufficient |

## Cost guardrails

Per-stream budget envelopes derived from `docs/scope-answers.md` re-run #2.

**Cost-rate assumption**: **$3.50 per agent-hour of LLM spend** (cached, mixed Sonnet/Opus per the model matrix below). This is the *cost* per hour the agent is actively working — not a token rate. Token consumption per agent-hour varies by model and prompt-cache hit rate; the dollar column below is `agent_hours × $3.50`.

| Stream | Hours low / high | LLM $ low / high (= hours × $3.50) | Hard kill at |
|---|---|---|---|
| D redaction | 16 / 32 | $56 / $112 | $250 |
| E audit log | 10 / 20 | $35 / $70 | $200 |
| A Google | 28 / 58 | $98 / $203 | $400 |
| C sensitive | 12 / 24 | $42 / $84 | $200 |
| B autodraft | 37 / 70 | $130 / $245 | $500 |
| F briefing | 16 / 32 | $56 / $112 | $250 |
| G quick-add | 16 / 32 | $56 / $112 | $250 |
| H assistant | 8 / 16 | $28 / $56 | $150 |
| I tags + search | 12 / 24 | $42 / $84 | $200 |
| J docs + lint | 8 / 16 | $28 / $56 | $150 |
| **Totals** | **163 / 324** | **$571 / $1,134** | **$2,550 hard cap** |

Hard kill ⇒ human inspects, decides to extend, replan, or trim.
Never silent.

## Phased rollout (graduated trust)

**Stage 1 — pilot (1 agent, low blast radius)**
- Run agent **D** alone. Token cap $250. Model: Opus (correctness-critical).
- Human reviews PR end-to-end; tracks deviations.
- **Pass criterion**: PR merges with ≤2 review comments and no invariant regressions.

**Stage 2 — serial chain (Phase 1 agents)**
- D → E → A → C, one at a time, each waiting for prior merge.
- No parallelism yet. Validates the coordination protocol on real merges.
- **Pass criterion**: 4 consecutive merges with cumulative review-comment count <10.

**Stage 3 — Phase 2 fan-out**
- 4 agents in parallel: B, F, G, H. (I queued.)
- Validates bulkheads + concurrency cap + spec-adherence lint.
- **Pass criterion**: 4 parallel merges in one calendar day with no merge conflicts.

If Stage 1 fails, do not graduate. Stay sequential.

## Operating decisions (locked 2026-05-08)

1. **Subagent tool**: Claude Code `Agent` with `subagent_type: general-purpose` and `isolation: worktree`. Re-evaluate only if isolation proves insufficient.
2. **Agent run log location**: existing audit Google Sheet (reuse SY-017 infra).
3. **Spec drift policy**: agent **stops and asks** if it surfaces a spec gap; never extends spec inline.
4. **Model matrix**:
   - **Opus**: D redaction (correctness-critical), SY-013 counterfactual ranking (PR3).
   - **Sonnet**: every other stream (default).
   - **Fast/Haiku**: J lint additions, doc copy-edits if size warrants.

## Pre-conditions to start Stage 1

- [x] PR2 spec sign-off recorded (PR #10).
- [x] Hard prereqs P1–P4 agreed (admin work in flight via `docs/pr2-prereqs-runbook.md`).
- [x] Automode plan committed (this PR).

**Note**: agent D (redaction filter) does **not** depend on P1–P4 — it's
pure TypeScript + tests, no Google or Anthropic API calls until the
wrapper is exercised. Stage 1 launches now in parallel with the
prereq runbook. Stage 2 agents (A onward) wait for prereq completion.
