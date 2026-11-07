# 0086 — The platform admin's AI cost page

**Status:** accepted, 2026-11-07 (the user approved `docs/mocks/admin-ai-cost.html` with all eight decisions as recommended). No migration.

**Context.** `ai_run` holds every AI call's cost, but no screen added it up across agencies, and the platform runs on a $20 a day limit nobody could see against.

**Decision.**
1. `/ai-cost` in the admin sidebar, and `/ai-cost/[agencyId]`. `platform:read` only; agencies do not see it. Read only: limits stay in Vercel. Both pages are logged like every admin page.
2. US dollars only: the price list and the limit are in USD, and we keep no exchange rate.
3. Periods of 24 hours, 7 days and 30 days, in the URL. The limit card always shows the same rolling 24 hours the budget check reads, from the same `aiBudgetCaps`. The chart is 30 Sydney days.
4. Agents and owners are named inside an agency. Buyers never are: the public site is one line.
5. **Saved from now on:** Morning Brief, Important emails and floorplan reading now record their agency. Older rows stay as they are and show as "Not tied to an agency", with listing photos being indexed.
6. The page says what the limit stops (the assistant, AI skills, alert summaries, buyers' tasks) and what it does not: the public chat and buyer tools have their own daily caps on requests. Making them obey the $20 is a separate change, not made here. The hard ceiling is the Anthropic console's.
7. Warnings on the page only, from 80%. No email.
8. Every total comes from one grouped statement, so the tables cannot disagree. Two statements per page, none per row, on `ai_run`'s existing indexes.

**Not counted.** Twilio, Google Maps, Resend. Voyage's free allowance is not taken off. A model with no price counts as $0.00 (`costUsd`), and the page says how many calls that was.

**Where it lives.** `packages/core/src/platform/ai-cost.ts`, `aiBudgetCaps` in `assistant/budget.ts`, `apps/console/app/(admin)/ai-cost`, `apps/console/components/admin/ai-cost.tsx`.
