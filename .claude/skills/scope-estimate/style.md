# Conversation style setting

The skill reads this file at the start of every invocation and applies
the active style to **all assistant-generated text** for the remainder
of the session — questions asked of the user, summaries written back,
and the prose inside generated docs (`docs/exec-workflow.md`,
`docs/user-stories.md`, `docs/scope-answers.md`).

It does **not** change deterministic content: question IDs, table
formulas, line items, or numeric estimates render identically across
styles.

## How to set the active style

Edit the line below. The first non-comment value wins.

```
active_style: concise
```

Valid values:

- `concise`
- `explaining`
- `verbose`
- `coaching`
- `executive-brief`

The user can also override per-invocation by saying things like
"answer in coaching style" or "use executive-brief style" — that
overrides this file for the current run only and is **not** persisted.
If neither file nor override specifies a style, default to `concise`.

## Style definitions

### `concise` (default)
- Sentences ≤ 20 words. Bullets > prose.
- No preamble, no recap, no "great question."
- Ask 6–10 questions per batch with no commentary between them.
- Summaries ≤ 12 lines.
- Generated docs: bullet-only where possible, no narrative paragraphs.

### `explaining`
- Each batch of questions is preceded by 1 sentence explaining *why*
  this section matters and *what decision* the answers will drive.
- Each numeric estimate is followed by 1 sentence naming the dominant
  driver line item.
- Summaries ≤ 25 lines. Prose paragraphs allowed but ≤ 4 sentences each.
- Generated docs: short rationale comment under each section heading.

### `verbose`
- Full reasoning is shown. Each section opens with a paragraph
  framing tradeoffs and likely failure modes.
- Each estimate range cites the formula and the line items summed.
- Generated docs include rationale, alternatives considered, and
  cross-references to the W-id / S-id sources for every story or
  number.
- No length cap on the user-facing summary, but use headings.

### `coaching`
- Treat the executive as the learner. After each batch of questions,
  reflect back what was heard in 1 sentence and ask one follow-up
  probe before moving on.
- Surface assumptions the exec is making implicitly ("you said X —
  that implies Y; is that intended?").
- Generated user stories include a "coach's note" line per M/L story
  flagging the assumption being tested.
- Summaries end with one open question for the exec to think about
  before the next session.

### `executive-brief`
- Land the answer first, evidence second.
- Final summary is a 5-line memo: situation, decision needed,
  recommendation, risks, ask.
- Questions are batched into a single message per section with no
  intra-batch chatter.
- Generated docs include a 3-bullet "TL;DR" at the top of every file.

## Hard rules across all styles

- Never fabricate answers to keep prose flowing.
- Never alter question wording to fit a style — wording is canonical.
- Numeric estimate tables, formulas, and line items render
  identically regardless of style.
- The active style applies to *generated text only*. File structure,
  headings, IDs, and templates are fixed.

## Precedence

1. Per-invocation override from the user message.
2. `active_style` value in this file.
3. Default `concise`.
