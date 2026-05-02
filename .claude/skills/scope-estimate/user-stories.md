# User-story generation rules

After `docs/exec-workflow.md` is filled (Module A), generate
`docs/user-stories.md` from those answers.

## Three lenses, always

Every workflow signal is converted into stories under three personas:

1. **USER** — the executive doing the work. Story format:
   `As an exec, I want <capability> so that <outcome from W answer>.`
2. **SYSTEM** — autonomous behaviors the product must perform without
   being asked. Story format:
   `When <trigger>, the system shall <behavior> so that <invariant>.`
3. **ADMIN** — governance, configuration, audit, access. Story format:
   `As an admin, I want <control> so that <policy / risk mitigated>.`

## Mapping rules (W-id → story lens)

| W section | USER stories | SYSTEM stories | ADMIN stories |
|-----------|--------------|----------------|----------------|
| A. role/rhythms | "Monday view," weekly cadence | morning surfacing rules | working hours / TZ config |
| B. contact lifecycle | quick-add, pre-call brief | dedupe, contact resurrection | sensitive-contact flagging, retention |
| C. call capture | note editor, templates | transcript ingestion, action extraction | append-only lock, redaction |
| D. follow-up | one-click draft, edit-then-send | auto-suggest moments to draft | "never auto-send" guard, send-as identity |
| E. email | inbox-linked context | thread fetch / sync | per-sender exclusion list |
| F. projects/tasks | weekly screen, delegation view | overdue surfacing, slip detection | priority schema, ownership rules |
| G. delegation | shared notes, mention/handoff | digest routing to EA | role-based read scope |
| H. decisions/priorities | "do this first" panel | ranking model, explanation traces | which signals are allowed to influence ranking |
| I. pain/dream | golden-path UX stories | proactive nudges | feedback / kill-switch |
| J. permissions/privacy | per-contact privacy toggle | redaction in LLM calls | audit log, data export, offboarding |

## How to convert an answer into stories

For each answered W-question:

1. Quote the exec's answer (1 line) as the **trigger**.
2. Write **at least one** USER story rooted in that quote.
3. If the answer implies an automated behavior, write a SYSTEM story.
4. If the answer implies a policy, role, or sensitive-data concern,
   write an ADMIN story.
5. Tag every story with:
   - a stable id `US-###`, `SY-###`, `AD-###`
   - the source `W-id`
   - a t-shirt size: `XS / S / M / L`
   - a priority: `must / should / could`
6. **Acceptance criteria** — for every M/L story, write 2–4 bullet
   acceptance criteria in Given/When/Then form. XS/S can use a single
   "Done when…" line.
7. Cross-link to the technical scope: list the S-ids from
   `questions.md` that this story depends on (e.g. `links: S2.5, S3.2`).
8. Mark stories `out-of-PR1` if they require capabilities the defaults
   in `defaults.md` defer.

## Quality bar

- Stories must be testable. "User has a great experience" is not a
  story; "Exec can save a call note in <30s on desktop" is.
- No duplicates across lenses. If a behavior is automatic, it belongs
  under SYSTEM, not USER.
- ADMIN stories must each name a concrete control surface (config flag,
  RLS policy, audit table, env var, role).
- If a workflow answer is `_unanswered_`, do not invent stories from
  it. List the W-id under `## Unblockers`.

## Output ordering

`docs/user-stories.md` sections, in order:

1. Source — link to `docs/exec-workflow.md` and the date.
2. **USER stories** grouped by W-section.
3. **SYSTEM stories** grouped by W-section.
4. **ADMIN stories** grouped by W-section.
5. **Cross-cutting invariants** — a short list of properties no PR is
   allowed to break (e.g. "the system never auto-sends email,"
   "OAuth tokens are encrypted at rest").
6. **Unblockers** — W-ids still unanswered, blocking story creation.
7. **PR routing** — for each story, the proposed PR (1/2/3) based on
   the must/should/could priority and whether `out-of-PR1` was set.
