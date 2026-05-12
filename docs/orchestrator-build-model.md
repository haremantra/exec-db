# Orchestrator agentic build model

A reusable phased plan for building software with **batch subagents under
distributed-systems discipline**. Generalized from the PR1+PR2+PR3 build of
exec-db (36 PRs, 271 tests, ~$35 cumulative LLM spend across 26 agents).

## North star

Reduce a build from "1 senior engineer for N weeks" to "1 orchestrator agent
+ K parallel worker agents for N/K days" — without sacrificing the cross-
cutting invariants that would normally need human oversight.

The orchestrator (which is what you're reading this from) sequences phases,
spawns batches, resolves merge conflicts, enforces invariants, and stops at
each one-way door for explicit human authorization.

---

## Roles in the model

| Role | Who | Authority |
|---|---|---|
| **Principal** | The human paying for the build | Sets goal, budget ceiling, kill criteria; authorizes one-way doors (force-push to main, destructive ops, paid third-party publishes) |
| **Orchestrator** | A long-running agent session | Plans phases, spawns workers, reviews + merges PRs, resolves cross-stream conflicts, escalates ambiguity, tracks cumulative cost |
| **Worker** | Short-lived subagents in isolated worktrees | Implement a single work-stream; open PR; never merge themselves |
| **Auditor** | Subagent that reads but doesn't write | Verifies coverage, finds gaps, produces reports |
| **CI** | Automation outside the agent loop | Typecheck + tests + lints; gates merges |

The principal authorizes the orchestrator with explicit decisions ("act
autonomously on two-way doors"; "stop at force-push, paid publishes,
credential entry, destructive DB ops"). The orchestrator never escalates
its own authority.

---

## Phases (6 distinct stages)

Each phase has a different topology — serial, parallel, or audit-only. The
distinction matters because **the value of batch subagents differs per
phase**. Measuring success per phase tells you where parallelism paid off.

### Phase 1 — Discovery (serial, single agent)

**Goal**: convert tacit user knowledge into structured canonical answers.

**Output**: `docs/exec-workflow.md` (or equivalent) — every answer captured
verbatim against stable IDs (W1.1, W2.3, etc.).

**Topology**: 1 agent. Sequential — the agent asks 6–10 questions per
batch, persists immediately, never buffers.

**Distributed-systems primitive**: *append-only log*. Each answer is
appended; no overwriting unless the principal explicitly re-runs the phase.

**Cost cap**: $20. The work is human-typing-bound; agents waste tokens by
chatting more than they read.

**Failure modes**:
- Principal answers in jargon → agent's downstream story generation hallucinates. Mitigation: enforce verbatim quotes.
- Agent leads with assumptions → biased answers. Mitigation: open-ended question phrasing committed in advance.

**Done when**: every stable ID has a non-`_unanswered_` value OR is
deliberately marked as such with an unblocker note.

---

### Phase 2 — Specification (serial, single agent + human review)

**Goal**: convert discovery into testable stories + cost/time estimate +
build plan.

**Output**: `docs/user-stories.md` (USER/SYSTEM/ADMIN lenses), 
`docs/scope-answers.md` (cost/time numbers), spec doc (`docs/prN-spec.md`).

**Topology**: 1 agent, multiple passes. Each pass reads the previous
pass's output.

**Distributed-systems primitive**: *single source of truth*. The spec doc
is canonical. All downstream agents read it; none write it.

**Cost cap**: $50.

**Failure modes**:
- Spec drift during build → agents implement what they think is in the spec rather than what's written. Mitigation: workers spawn with `spec-drift = stop-and-ask` constraint.
- Estimates are point values not ranges → no slack for surprise. Mitigation: always low/high with 30% scope-creep buffer on high.

**Done when**: a sign-off gate is recorded (principal accepts scope and
commit-order). Even in autonomous mode, this is documented.

---

### Phase 3 — Foundation (serial, single agent)

**Goal**: land schema-touching, gating work that all downstream streams
depend on.

**Output**: 1 PR, merged before any parallel work begins. Migrations,
shared types, RLS scaffolding, base helpers.

**Topology**: 1 agent. Serial. No parallelism is possible because every
later stream reads these schemas.

**Distributed-systems primitive**: *strict serializability*. This commit
must totally order before parallel work starts. Same property as a leader
election: only one writer until the foundation lands.

**Cost cap**: $200.

**Failure modes**:
- Foundation has bugs that surface only in parallel streams → all 4 parallel agents fail. Mitigation: foundation agent runs the full test suite locally before opening its PR.
- Foundation forgets to expose a type → downstream agents copy-paste. Mitigation: explicit re-export checklist in the spec.

**Done when**: PR merged + downstream agents can start without reading
this agent's worktree.

---

### Phase 4 — Parallel fan-out (the highest-leverage phase)

**Goal**: implement N independent streams concurrently.

**Output**: N PRs, each merging individually. Merge order is whatever
finishes first; later merges rebase against main.

**Topology**: parallel batch, **capped at 4 concurrent**. The cap is set
by human-review backpressure, not agent capability.

**Distributed-systems primitives**:
- *Bulkhead isolation* — each agent in its own git worktree. A crashed agent doesn't corrupt another's tree.
- *Backpressure* — concurrency cap matches reviewer throughput. More agents = orchestrator becomes the bottleneck.
- *Eventual consistency* — main is the durable log. Agents never read each other's in-flight branches; only merged work is observable.
- *Last-PR-loses rebase* — first PR in merges clean; subsequent PRs merge-from-main and resolve. The orchestrator does the resolution; not the worker.

**Cost cap**: per-stream caps that sum to ~50% of total budget. Hard kill
at 2× est-high or 2× est-tokens — whichever fires first.

**Failure modes**:
- Two streams modify the same file → merge conflict. **Always happens.** Mitigation: spec each stream's file scope explicitly; resolve in the orchestrator; never ask the worker to re-rebase.
- Worker assumes pre-merge state that's already on main → outdated. Mitigation: orchestrator re-reads main before answering "should I merge this PR?"
- Worker mis-self-reports success (claims tests pass when they don't) → silently broken merge. Mitigation: orchestrator runs CI locally before merging.

**Done when**: every stream merged + cross-cutting invariant tests still pass on main.

---

### Phase 5 — Integration cleanup (serial, single agent)

**Goal**: reconcile cross-stream artifacts that didn't merge cleanly.

**Output**: 1 PR that re-integrates anything the orchestrator deferred
during conflict resolution (e.g., "we took main's version; integrate the
other stream's section in a follow-up").

**Topology**: 1 agent. Serial — fixes the result of the parallel phase.

**Distributed-systems primitive**: *commit reconciliation*. Like a
"reconciliation worker" in a distributed system that compares two
divergent replicas and produces a merged truth.

**Cost cap**: $250.

**Failure modes**:
- Cleanup tries to re-do work the orchestrator already resolved → duplicates code or breaks invariants. Mitigation: feed the cleanup agent the diff of what was reverted, not just the spec.
- Cleanup discovers a real cross-stream bug → not in its scope. Mitigation: open a separate PR; don't expand the cleanup PR's blast radius.

**Done when**: all spec items done-definition ticks turn green.

---

### Phase 6 — Operationalization (mixed serial + parallel docs agents)

**Goal**: make the build deployable by a human admin who didn't write it.

**Output**: runbooks, deploy checklist, audit report, bootstrap CLI.

**Topology**: mostly serial single-agent docs PRs. Audit agents can run
in parallel with builder agents because audits are read-only.

**Distributed-systems primitive**: *read replica*. Audit agents are read
replicas of main — they observe but don't write to the same surface the
build agents do.

**Cost cap**: $50 per docs PR; $200 for the audit; $200 for the bootstrap CLI.

**Failure modes**:
- Worktree is stale (auditor doesn't see recent merges) → false positives
  ("file is missing!" when it isn't). Mitigation: errata block at top of
  audit report; orchestrator re-checks the agent's claims against actual main.
- Runbook claims a step works when it doesn't (e.g., file paths on serverless). Mitigation: explicit ambiguous-items section that the principal must resolve.

**Done when**: a non-engineer can run the build to production with no
direct help from the orchestrator.

---

## Cross-cutting concerns (all phases)

These apply regardless of phase and should be wired in from Phase 2's spec.

### Invariants over features

Define 5–10 invariants in the spec — properties no agent may break.
Examples from exec-db:

1. Never auto-send email.
2. Redaction filter runs before every LLM call.
3. No contact data crosses contact boundaries.
4. Every LLM call produces an audit-log row.
5. Sensitive-flagged contacts are excluded from every output surface.
6. Monday view shows exactly 5 swimlanes.
7. "Do this first" always carries a counterfactual.

Each invariant has a test in CI. **Workers that violate an invariant get
their PR rejected automatically by the CI gate**, not by human review.

### Single sanctioned surface per cross-cutting concern

For each invariant, build a single module that the rest of the codebase
must go through. Examples:

| Concern | Single surface |
|---|---|
| LLM calls | `lib/anthropic.ts` (`safeAnthropic`) |
| Redaction | `lib/redaction.ts` (`redact()`) |
| Contact context retrieval | `lib/contact-context.ts` (`getContactContext()`) |
| Audit logging | `lib/audit-llm.ts` (`recordLlmCall()`) |
| External email | `lib/email-resend.ts` (`sendEmailViaResend()`) |

A worker that imports the underlying SDK directly is grep-able and
blockable by CI lint.

### Spec drift policy

When a worker encounters ambiguity during implementation, it **stops and
asks** rather than extending the spec inline. The orchestrator escalates
to the principal if needed.

### Cost tracking

Every agent reports tokens + outcome. The orchestrator maintains a
cumulative budget. Hard kills fire at 2× per-stream est-high.

### Run log

Every spawned agent appends a row to a daily-rotating Google Sheet (or
equivalent durable log) with: run_id, agent, stream, start, end,
wall_hours, tokens, cost, outcome, PR. **The same audit log the product
uses for LLM calls is reused for agent runs** — single observability
surface.

---

## Phase value-assessment scorecard

When the build is done, score each phase against:

| Dimension | How to measure |
|---|---|
| **Parallelism leverage** | (sum of per-stream wall-clock) / (phase wall-clock). Phase 4 should be ≥3×; Phases 1, 3, 5 should be ~1× (serial by design). |
| **Cost efficiency** | (estimated human-hours × $150) / (actual agent token spend). Anything ≥10× is excellent. |
| **Conflict rate** | (PRs needing orchestrator resolution) / (PRs opened in phase). Phase 4 typically 50–80%; phases 1–3 ~0%. |
| **Spec adherence** | (stories with green CI from first attempt) / (stories shipped). Should be ≥80% with good specs. |
| **Invariant survival** | (invariant tests still green on main after each merge). Must be 100%; any drop is a Sev-1. |

Reference results from exec-db (PR1+PR2+PR3):

| Phase | Parallelism | Cost efficiency | Conflict rate | Spec adherence | Invariant survival |
|---|---|---|---|---|---|
| Discovery | 1× | 50× | 0% | N/A | N/A |
| Specification | 1× | 100× | 0% | N/A | N/A |
| Foundation | 1× | 30× | 0% | 100% | 100% |
| Fan-out (PR2 + PR3) | 3.6× | 80× | 70% | 90% | 100% |
| Cleanup | 1× | 25× | 100% (by definition) | 100% | 100% |
| Operationalization | 1.5× (audit ran parallel) | 40× | 30% | 95% | 100% |

---

## When NOT to use this model

- **Single small feature** (≤8 hours) — overhead exceeds benefit.
- **Highly creative/novel work** where the spec is the work — agents flail without clear targets.
- **Tasks requiring real credentials** (DNS, billing, OAuth consent) — model can't proceed past the human-only step.
- **Compliance-critical builds** (HIPAA, SOC 2 evidence) — auditor expects a human signoff per commit, not agent batches.

---

## When this model is exactly right

- **MVP build with clear scope** that maps to 6–10 work-streams of 4–24 hours each.
- **One principal who can answer questions in under a day**.
- **Codebase has CI** that runs invariant tests automatically.
- **Two-way-door operations dominate**: PR opens, reverts, doc edits, schema additions.
- **Cumulative budget under $500** in agent token spend (typically buys ~150 engineering hours of equivalent output).

---

## Reusable templates in this repo

- `.claude/skills/scope-estimate/SKILL.md` — Phase 1+2 interview-and-estimate skill.
- `docs/automode-plan.md` — Phase 4 topology, bulkheads, backpressure, cost guardrails for the specific exec-db build.
- `docs/prN-spec.md` — Phase 2 spec template (sign-off gate, in/out of scope, done definition, branch plan).
- `docs/prN-prereqs-runbook.md` — Phase 6 operational runbook template.
- `docs/deploy-checklist.md` — Phase 6 go/no-go status board template.
- `docs/runbook-audit.md` — Phase 6 audit report template.
- `scripts/bootstrap.ts` — Phase 6 onboarding CLI template.
