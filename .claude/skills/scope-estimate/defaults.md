# MVP defaults

Apply when the user says "use defaults" / "MVP defaults". Each default
is chosen to minimize PR1 scope while keeping the autodraft + digest
thesis testable. Mark each default-applied answer with `(default)` in
`docs/scope-answers.md`.

## 1. Product boundary
- S1.1 internal MVP
- S1.2 foundation only — no UX polish in PR1
- S1.3 3–10 execs only
- S1.4 desktop-only
- S1.5 demoted from navigation, kept in DB

## 2. CRM
- S2.1 name, email, company, title, notes — no tags/stage in PR1
- S2.2 backend table only; no account UI in PR1
- S2.3 manual create only; Google import deferred
- S2.4 simple list with text filter; no advanced search
- S2.5 markdown rendering only
- S2.6 editable by author for 24h, then append-only
- S2.7 yes — shared per contact
- S2.8 yes — single optional date field
- S2.9 all exec_all see everything

## 3. Autodraft
- S3.1 click-to-generate only
- S3.2 in-app review first; Gmail draft on accept
- S3.3 drafts only — never auto-send
- S3.4 founder-style concise, configurable string
- S3.5 call notes only in PR2; Gmail history added late PR2
- S3.6 last 5 threads with that contact
- S3.7 plain copy in PR2; citations deferred
- S3.8 subject + body only
- S3.9 stored, marked discarded
- S3.10 Sonnet by default; Opus opt-in per draft

## 4. PM
- S4.1 project + task only
- S4.2 individual exec owners
- S4.3 deferred
- S4.4 backend table only
- S4.5 deferred
- S4.6 low/medium/high
- S4.7 email digest only — no in-app reminders
- S4.8 deferred

## 5. Digests
- S5.1 sent via Resend/app email — not Gmail send
- S5.2 opt-in per user
- S5.3 weekly = wider window of same query
- S5.4 assigned + owned
- S5.5 simple rules
- S5.6 deterministic markdown — no Claude in v1
- S5.7 unsubscribe yes; snooze deferred
- S5.8 single fixed timezone (America/Los_Angeles)

## 6. Google
- S6.1 OAuth required in PR2
- S6.2 assume not configured — budget 4h to set up
- S6.3 internal Workspace only
- S6.4 Calendar read-only, Gmail read-only, Gmail compose
- S6.5 Resend handles digests; no Gmail send scope
- S6.6 snippets sufficient
- S6.7 persisted with TTL
- S6.8 acceptable but encrypted column
- S6.9 simple email equality
- S6.10 logs only in v1

## 7. Auth/RLS
- S7.1 stub OK for PR1; real auth in PR2
- S7.2 Clerk
- S7.3 yes — per-user Google tokens
- S7.4 exec_all only in v1
- S7.5 placeholder only
- S7.6 deferred to PR3
- S7.7 DB only
- S7.8 yes — pgcrypto column encryption
- S7.9 internal experimental — no compliance regime

## 8. Vision-check
- S8.1 separate dev tool — not blocking PR1
- S8.2 local questionnaire writing docs/vision.md
- S8.3 after every turn
- S8.4 configurable env var, default opus-4-7
- S8.5 deferred
- S8.6 vision.md only

## 9. Architecture
- S9.1 Next.js route handlers + manual scripts
- S9.2 Vercel Cron acceptable
- S9.3 assume needs 1 day cleanup
- S9.4 no dbt
- S9.5 typecheck + manual; 1 smoke test per server action
- S9.6 yes — seed script
- S9.7 yes — server actions only
- S9.8 minimal

## 10. Delivery
- S10.1 $40k ceiling
- S10.2 fastest usable demo
- S10.3 Gmail autodrafts
- S10.4 vision-check CLI
- S10.5 short spec before each PR
- S10.6 fixed-scope/fixed-fee per PR
- S10.7 PR1 merged + exec can create contact and call note in staging
