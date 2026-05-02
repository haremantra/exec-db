# Scoping questions

Each question has a stable ID `S<section>.<n>` so answers can be diffed
across runs.

## 1. Product boundary
- S1.1 Is the target for this build internal MVP, production internal tool, or prototype to validate direction?
- S1.2 Should PR 1 ship only the foundation, or should it include enough UX polish that execs can actually use CRM/PM day to day?
- S1.3 Is the "exec team only" audience literally 3-10 people, or do function leads/managers need real access soon?
- S1.4 Do you need mobile-friendly UI in this phase, or desktop-only is acceptable?
- S1.5 Should the existing SaaS mirror domains remain visible anywhere in the app, or be fully demoted from navigation?

## 2. CRM functionality
- S2.1 What is the minimum useful contact record (name/email/company/title only, or tags, owner, stage, last-touch, next-step, etc.)?
- S2.2 Do contacts need account/company grouping in PR 1, or can crm.account exist only as a backend table for now?
- S2.3 Should contacts be manually created only, or imported from Google Contacts/Gmail later?
- S2.4 Do you need contact search/filtering in PR 1, or is a simple list enough?
- S2.5 Should call notes support markdown rendering only, or also templates, action extraction, attachments, or AI summaries?
- S2.6 Should call notes be editable/deletable, or append-only for auditability?
- S2.7 Should multiple exec users be able to see and add notes to the same contact?
- S2.8 Do you need a "next follow-up date" field now?
- S2.9 Do you need contact/account ownership rules, or can all exec_all users see everything?

## 3. Autodraft behavior
- S3.1 Should autodrafts be created automatically after every call note, or only when the user clicks "Generate follow-up"?
- S3.2 Should drafts be saved directly into Gmail, or first shown in-app for review?
- S3.3 Should the system ever send emails automatically, or only create drafts?
- S3.4 What tone should drafts use (founder-style concise, formal executive, warm sales follow-up, configurable)?
- S3.5 Should drafts use only call notes, or also calendar context and Gmail history from day one?
- S3.6 How much Gmail history is enough (latest thread only, last 5 threads, search by contact)?
- S3.7 Should the draft include citations/traceability to the source note/thread, or just plain email copy?
- S3.8 Do you need structured draft outputs (subject, body, rationale, risks, follow-up tasks)?
- S3.9 Should rejected/discarded drafts be stored for learning/audit, or simply marked discarded?
- S3.10 Is Claude Opus required for all drafting, or can Sonnet/cheaper model be used for non-critical drafts?

## 4. PM functionality
- S4.1 Minimum project model: project plus tasks, or milestones, owners, dependencies, labels, status history?
- S4.2 Are tasks owned by individual execs only, or can teams/functions own tasks?
- S4.3 Do you need comments/activity history on tasks?
- S4.4 Do task dependencies matter in PR 1, or can pm.task_dependency be backend-only?
- S4.5 Should tasks support recurring items?
- S4.6 Should tasks support priority as 1-10, low/medium/high, or no priority at first?
- S4.7 Do you need due-date reminders in-app, or only email digests?
- S4.8 Should task updates be made only in the app, or also from email replies later?

## 5. Digest behavior
- S5.1 Should digests be sent by Gmail as the exec, by a shared app address, or not sent initially and only previewed in-app?
- S5.2 Should daily digests be mandatory for all execs or opt-in per user?
- S5.3 Should weekly digests differ from daily digests, or can weekly be a wider-window version of the same query?
- S5.4 Should digests include only tasks assigned to the recipient, or also tasks they own as project owner?
- S5.5 Should blocked/overdue/high-priority tasks be ranked by simple rules or by Claude?
- S5.6 Can digest formatting be deterministic markdown without Claude in v1 to reduce cost/complexity?
- S5.7 Do you need "snooze" or "unsubscribe" controls in PR 3?
- S5.8 Is 7am local time required, or can cron run in one fixed timezone?

## 6. Google integration
- S6.1 Is Google OAuth required in PR 2, or can you start with manual API credentials/service-account style setup for the exec team?
- S6.2 Do you already have a Google Cloud project and OAuth consent screen configured?
- S6.3 Is this Google Workspace internal-only, or does the app need external Gmail accounts too?
- S6.4 Which scopes are acceptable initially (Calendar read-only, Gmail read-only, Gmail compose, Gmail send)?
- S6.5 Is Gmail send required for digests, or can Resend/app email handle digests to avoid Gmail send scope?
- S6.6 Do you need full Gmail message bodies, or is metadata/snippets sufficient for v1?
- S6.7 Should synced calendar/email data be stored permanently, or fetched on demand where possible?
- S6.8 How sensitive is storing Gmail snippets in Postgres (acceptable, encrypted, or avoid)?
- S6.9 Should contact matching be simple email equality, or do you need fuzzy/domain-based matching?
- S6.10 Do you need sync status/error UI, or logs are enough for v1?

## 7. Auth, security, and RLS
- S7.1 Is stub auth acceptable for PR 1 only, or should real auth be introduced immediately?
- S7.2 Which auth provider do you prefer (keep stub, Clerk, WorkOS, Google Workspace auth, Auth.js, other)?
- S7.3 Do you need per-user Google tokens before production use?
- S7.4 Should function_lead and manager have read access to CRM/PM in v1, or should CRM/PM be exec_all only?
- S7.5 Should employees ever see their own PM tasks, or is that only a future placeholder?
- S7.6 Do CRM/PM writes need full audit triggers in PR 1, or can audit be deferred?
- S7.7 Do you need audit logs visible in the UI, or database-only is enough?
- S7.8 Do you require encryption at rest for OAuth tokens in Postgres in v1?
- S7.9 Are there compliance requirements, or is this internal experimental tooling?

## 8. Vision-check CLI
- S8.1 Is vision-check truly required in PR 1, or can it be a separate developer tool later?
- S8.2 Does it need to call Claude live, or could v1 be a local questionnaire that writes docs/vision.md?
- S8.3 Should it update docs/vision.md after every turn, or only at the end?
- S8.4 Is claude-opus-4-7 required, or can it use a configurable model env var?
- S8.5 Do you need prompt caching implemented in v1, or can that be deferred?
- S8.6 Should the CLI produce only docs/vision.md, or also tickets/specs for PR 2 and PR 3?

## 9. Architecture and implementation shortcuts
- S9.1 Is BullMQ/Redis required in PR 2/3, or can workers start as Next.js route handlers/manual scripts?
- S9.2 Is Vercel Cron acceptable, or do you expect a long-running worker process?
- S9.3 Is Docker/local Postgres already stable, or should budget include dev-environment cleanup?
- S9.4 Do you need dbt/warehouse work in this pivot? (spec says no — confirm)
- S9.5 Do you need automated tests added, or is typecheck plus manual verification enough for MVP?
- S9.6 Do you need seed/demo data for local testing?
- S9.7 Should server actions be the only write path in PR 1, as specified?
- S9.8 Should app styling remain minimal, or do you want a polished executive dashboard?

## 10. Delivery and budget control
- S10.1 What budget ceiling are you trying to hit ($25k, $40k, $60k, $80k, other)?
- S10.2 What timeline matters more (fastest usable demo, lowest cost, best long-term architecture)?
- S10.3 Which is the must-have outcome (CRM notes, PM task digests, Gmail autodrafts, vision-check)?
- S10.4 Which feature is easiest to defer without hurting the thesis?
- S10.5 Should the implementer produce PR 2/3 specs before coding each PR, or just implement from the sketch?
- S10.6 Do you want fixed-scope/fixed-fee milestones, or time-and-materials with weekly checkpoints?
- S10.7 What is the definition of "done" for the first paid milestone?
