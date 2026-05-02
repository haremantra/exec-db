---
name: scope-estimate
description: Two-module skill for the exec-db pivot. Module A captures an executive's actual workflow via canonical questions and generates USER / SYSTEM / ADMIN user stories from those answers. Module B captures PR1/PR2/PR3 technical scoping decisions and produces cost USD, clock-time weeks, and autonomous-agent terminal-time hours (plus token spend). Module A runs first by default. Honors a configurable conversation style (concise / explaining / verbose / coaching / executive-brief) read from style.md. Use when the user asks to crystallize an exec workflow, generate user stories, scope/estimate the build, or "answer the questions."
---

# scope-estimate

Two modules, run in order:

**Module A — exec workflow → user stories**
1. Ask the canonical workflow questions in `exec-workflow.md`.
2. Persist answers to `docs/exec-workflow.md`.
3. Generate `docs/user-stories.md` (USER, SYSTEM, ADMIN lenses) using
   the rules in `user-stories.md`.

**Module B — scope estimate**
1. Ask the technical scoping questions in `questions.md`.
2. Persist answers to `docs/scope-answers.md`.
3. Compute cost USD, clock-time weeks, and autonomous-agent
   terminal-time hours + token spend using `estimation.md`.

## Step 0 — load the style setting

Before doing anything else, read `style.md` and apply the active
style to every piece of assistant-generated prose for the rest of the
run (questions, summaries, narrative inside generated docs). The
user may override with phrases like "use coaching style" or "answer
in executive-brief" — per-invocation overrides win over the file.
Numeric estimates, IDs, headings, and table formulas are unaffected
by style.

## When to invoke

- "crystallize my workflow" / "interview me" / "run the exec questions"
- "generate user stories" / "give me USER/SYSTEM/ADMIN stories"
- "answer the scope questions" / "estimate this build"
- "scope/budget the exec-db pivot"
- user pastes the long question list and asks for estimates

If the user names only one module, run only that module. Otherwise
default to A then B, and confirm before starting B if A produced any
unanswered W-ids.

## Module A workflow

1. **Locate or create `docs/exec-workflow.md`** from
   `exec-workflow-template.md`. Preserve any existing answers.
2. **Collect answers** to W1–W10 in batches of 6–10. Quote the exec
   verbatim where possible — these are inputs to story generation.
   Save each batch immediately.
3. **Generate `docs/user-stories.md`** from
   `user-stories-template.md`, applying every rule in
   `user-stories.md`:
   - Three lenses (USER / SYSTEM / ADMIN), no duplicates.
   - Stable IDs `US-###`, `SY-###`, `AD-###`.
   - Each story tagged with source W-id, t-shirt size, must/should/could,
     and links to S-ids from the technical questionnaire.
   - Acceptance criteria for every M/L story.
   - List unanswered W-ids under `## Unblockers`.
4. **Show a short summary** in the active style: counts per lens,
   any cross-cutting invariants discovered, and the top 3 stories
   the exec should sanity-check.

## Module B workflow

1. **Locate or create `docs/scope-answers.md`** from `template.md`.
2. **Collect answers** to S1–S10. If the user says "use defaults" /
   "MVP defaults", apply `defaults.md` and tag each answer
   `(default)`. If `docs/user-stories.md` exists, prefer answers
   consistent with the priority of stories already marked `must`.
3. **Compute estimates** using the deterministic line items in
   `estimation.md`. Do not guess totals — sum the rows.
4. **Write the Estimates block** at the bottom of
   `docs/scope-answers.md`:
   - Per-PR breakdown (PR1 foundation, PR2 Google + autodraft, PR3
     PM digests, vision-check CLI).
   - Cost low/high USD.
   - Clock-time low/high weeks (1 senior full-stack dev at 30
     productive hr/wk unless user says otherwise).
   - Terminal-time low/high agent wall-clock hours, human-review
     hours (≈10%), and token spend at $3.50/agent-hour cached
     ($11/agent-hour uncached).
   - Top 3 cost drivers and top 3 deferrable items.
5. **Show a short summary** in the active style: the three numbers,
   the assumptions that drove them, and the path to the file.

## Files in this skill

- `style.md` — active conversation style + style definitions.
- `exec-workflow.md` — canonical exec workflow questionnaire (W-ids).
- `exec-workflow-template.md` — skeleton for `docs/exec-workflow.md`.
- `user-stories.md` — rules for generating user stories.
- `user-stories-template.md` — skeleton for `docs/user-stories.md`.
- `questions.md` — technical scoping questionnaire (S-ids).
- `template.md` — skeleton for `docs/scope-answers.md`.
- `defaults.md` — MVP defaults for every S-id.
- `estimation.md` — line items, rates, token model, sanity bands.

## Hard rules

- Always read `style.md` first and apply the active style to all
  assistant-generated prose.
- Always write to the canonical paths
  (`docs/exec-workflow.md`, `docs/user-stories.md`,
  `docs/scope-answers.md`) unless the user passes a different path.
- Never invent answers the user did not give and did not delegate to
  defaults. Mark unknown items `_unanswered_` and exclude them from
  estimates and from story generation; flag them as blocking.
- Never alter the wording of W- or S- questions to fit a style.
- Stories must be testable. No "user has a great experience" stories.
- Estimates are ranges, not point numbers. Low = best case with
  defaults honored; High = realistic case with ~30% scope creep.
- Terminal-time and clock-time are independent estimates — do not
  derive one from the other.
- Do not commit the generated docs automatically. Ask first.
