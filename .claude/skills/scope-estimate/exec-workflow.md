# Exec workflow questionnaire (Module A)

This is the **first** set of questions to run — before the technical
scope questionnaire in `questions.md`. The goal is to crystallize the
executive's real workflow in their own words, then derive user stories
from that ground truth instead of from feature guesses.

Output file: `docs/exec-workflow.md`.

Each question has a stable ID `W<section>.<n>`. Answers are free-text;
do not coerce into yes/no. Keep them in the executive's voice — quote
verbatim where possible.

## A. Role and rhythms
- W1.1 What is your title and the 2–3 functions you actually own week to week?
- W1.2 Walk through a typical Monday from the moment you open your laptop until lunch. What apps do you touch, in what order?
- W1.3 What does a "good week" look like vs. a "bad week"? What signal tells you which one you're in by Wednesday?
- W1.4 How many hours per week do you spend in scheduled meetings vs. unscheduled work?
- W1.5 Which of your tasks would you most regret if a week passed and you forgot it?

## B. Contact lifecycle
- W2.1 Who are the categories of people you talk to (investors, customers, candidates, partners, board, internal reports)? Roughly how many active in each?
- W2.2 How does a new contact enter your world today — referral, inbound email, conference, intro thread? What's the most common path?
- W2.3 At what moment do you first feel "I need to remember this person"? What do you do at that moment today?
- W2.4 What context about a person do you wish you had in front of you 5 minutes before a call that you currently don't?
- W2.5 How do you decide who to follow up with this week vs. who to let go cold?
- W2.6 Are there contacts you should never see in a digest (legal, personal, board confidential)? How are they flagged today?

## C. Call and meeting capture
- W3.1 How do you take notes during or after a call today — paper, Notion, Notes.app, nothing?
- W3.2 What do you write down vs. what stays in your head?
- W3.3 How long after a call do you usually capture notes? Same hour, same day, never?
- W3.4 What's a note you wrote in the last month that paid off later? What made it useful?
- W3.5 What's a note you wished you had written but didn't?
- W3.6 If notes were searchable across all your contacts, what would be the first three searches you'd run?

## D. Follow-up workflow
- W4.1 When you say "I'll send a follow-up," what does that email usually contain — recap, next step, an attachment, an intro?
- W4.2 How long does it take you to write a typical follow-up today, from "I should write this" to "send"?
- W4.3 What percentage of intended follow-ups actually get sent within 24 hours?
- W4.4 When a draft is "wrong," what's usually wrong about it — tone, facts, length, missing context?
- W4.5 Do you want the system to draft for you, draft *with* you turn-by-turn, or just remind you to draft?
- W4.6 What's the worst thing the system could do here — send something embarrassing, surface a private note, miss a critical follow-up?

## E. Email and inbox reality
- W5.1 How many email accounts do you operate from? Which is the "real" one for exec work?
- W5.2 How do you triage inbox today — labels, snooze, inbox-zero, stars, search?
- W5.3 Which threads do you re-read repeatedly because you can't find what was decided?
- W5.4 Are there senders or threads the system must never read or quote? How are they identified?
- W5.5 Would you trust an automated draft saved into Gmail, or do you want to copy-paste from elsewhere first?

## F. Projects and tasks
- W6.1 What is a "project" to you in plain English — a hire, a launch, a deal, a board prep, an OKR?
- W6.2 Where do tasks live today — your head, a doc, Linear/Asana, a notebook, your calendar?
- W6.3 How often does a task you own slip past its date because it never resurfaced? What would resurface it ideally?
- W6.4 When you delegate a task, how do you confirm it's done?
- W6.5 What's the difference between "blocked" and "stuck" and "waiting on" in your head?
- W6.6 If you had a one-screen view of "what matters this week," what 5 fields would be on it?

## G. Delegation, team, and assistants
- W7.1 Who else (EA, chief of staff, function lead, manager) needs to see what you see, and who must not?
- W7.2 Today, what do you ask a person to do that the system could plausibly do?
- W7.3 What must always stay human-only and never be automated?
- W7.4 If a function lead reads your CRM notes about their domain, is that helpful or a problem?

## H. Decisions and priorities
- W8.1 When you sit down on a Monday, how do you decide what to work on first?
- W8.2 What inputs would change your priority list mid-week (board nudge, customer escalation, hiring signal)?
- W8.3 If the system surfaced one item per morning labeled "do this first," what would make you trust the suggestion?
- W8.4 How do you currently keep score on yourself — OKRs, weekly check-ins, gut, board updates?

## I. Pain points and dream state
- W9.1 In the last month, what's the single workflow moment that frustrated you most?
- W9.2 If a magic version of this product worked perfectly, describe a Tuesday morning with it. What's different about the first 30 minutes?
- W9.3 What would make you delete the product after one week?
- W9.4 What would make you tell another exec "you have to install this"?

## J. Permissions, privacy, boundaries
- W10.1 What data should never leave your laptop / your domain / Postgres?
- W10.2 Are there contacts whose existence is itself sensitive (acquisition target, candidate)?
- W10.3 If you leave the company, what happens to your CRM notes — exported, deleted, transferred?
- W10.4 Is there content you'd want auto-redacted in any LLM call (SSNs, salaries, deal terms)?
- W10.5 Do you want the system to log every LLM prompt it made on your behalf? Where would you read that log?
