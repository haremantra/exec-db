---
name: scope-estimate
description: Capture answers to the exec-db PR1/PR2/PR3 scoping questionnaire (product boundary, CRM, autodraft, PM, digests, Google integration, auth/RLS, vision-check CLI, architecture shortcuts, delivery/budget) into a local file, then produce a cost estimate, a clock-time estimate for a human team, and a terminal-time estimate assuming an autonomous coding agent (e.g. open-claw / Claude Code in headless mode) runs the build. Use when the user asks to scope, estimate, budget, or "answer the questions" for the exec-db pivot, or when they say things like "fill out the scope doc", "estimate this PR plan", or "run the questionnaire".
---

# scope-estimate

Captures scoping decisions for the exec-db CRM/PM/autodraft pivot and turns them
into three numbers the user actually cares about:

1. **Cost** in USD (human contractor + LLM usage).
2. **Clock time** — wall-clock weeks if a human team builds it.
3. **Terminal time** — wall-clock hours of an autonomous agent (open-claw /
   Claude Code headless) doing the build, plus the LLM token cost of that run.

## When to invoke

Trigger on any of:

- "answer the scope questions" / "fill out the questionnaire"
- "estimate this build" / "what would PR1+2+3 cost"
- "scope/budget the exec-db pivot"
- user pastes the long question list and asks for estimates

## Workflow

1. **Locate or create the answers file** at `docs/scope-answers.md`.
   - If it does not exist, write the full questionnaire from
     `questions.md` in this skill folder, with each answer line set to
     `_unanswered_`.
   - If it exists, read current answers and only fill blanks.

2. **Collect answers.** Two modes:
   - **Interactive**: ask the user the unanswered questions in batches of
     6–10, grouped by section. Use `AskUserQuestion` if available; otherwise
     plain prompts. Save each batch immediately — do not buffer the whole set.
   - **Defaults**: if the user says "use defaults" or "MVP defaults", apply
     the defaults table in `defaults.md` and note `(default)` after each.

3. **Persist answers** to `docs/scope-answers.md` using the structure in
   `template.md`. Keep the section headings exactly so future runs can
   diff. Never delete prior answers — replace in place.

4. **Compute estimates** using the rules in `estimation.md`. The formulas
   are deterministic — do not have the model "guess" totals. Sum line
   items, then write the **Estimates** block at the bottom of
   `docs/scope-answers.md` with:
   - Per-PR breakdown (PR1 foundation, PR2 Google + autodraft, PR3 PM
     digests, vision-check CLI).
   - Cost low/high in USD.
   - Clock-time low/high in calendar weeks (assume 1 senior full-stack
     dev unless user says otherwise).
   - Terminal-time low/high in hours of agent wall-clock and the
     estimated LLM token spend for that agent run.
   - Top 3 cost drivers and top 3 deferrable items.

5. **Show the user** a short summary (under 25 lines): the three numbers,
   the assumptions that drove them, and the path to the file. Do not
   re-print the whole questionnaire.

## Files in this skill

- `questions.md` — canonical question list, grouped into 10 sections.
- `template.md` — output skeleton for `docs/scope-answers.md`.
- `defaults.md` — MVP-default answer for every question.
- `estimation.md` — line-item hours, $/hr, token cost rules, and the
  "terminal time" model for autonomous agents.

## Hard rules

- Always write to `docs/scope-answers.md`, never elsewhere, unless the
  user passes a different path.
- Never invent answers the user did not give and did not delegate to
  defaults. Mark unknown items `_unanswered_` and exclude them from the
  estimate, flagging them as "blocking estimate accuracy".
- Show ranges, not point estimates. Low = best case with defaults
  honored; High = realistic case with usual scope creep (~30%).
- Terminal-time and clock-time are independent estimates — do not derive
  one from the other.
- Do not commit `docs/scope-answers.md` automatically. Ask first.
