# 0047 — A project (dashboard) is changed in the chat that made it; colours on request

**Status:** ACCEPTED and BUILT, 2026-10-16 (the user: "specific chat mai jisma wo bnaya hm update changing
krwa skien same project mai, new chat mai naya project bnna"), branch `feat/dashboard-update`.

## Problem

The assistant could only `create_dashboard`. Asked to change a project ("add a tile", "make it blue"),
it made a second project beside the first. Nothing let a dashboard's tiles, title, audience or colours
change after it was saved. Tables inside tiles only scrolled sideways on a phone.

## Decision

1. **One chat, one project.** A dashboard belongs to the conversation whose `create_dashboard` card was
   approved. That link is read from `proposed_action` (conversation, tool, `result.dashboardId`), so no
   new column is needed for it.
2. **`update_dashboard`** (write tool, card, Approve): changes the newest dashboard made in THIS chat, or
   the one named by its exact title. It can change the title, the tiles, who can open it and the colours.
   A tile can be kept as it is with `{ keep: n }`, so the model does not resend long queries. The card shows
   the tiles before and after. On Approve, `updateDashboard` asks `dashboard:manage` again, checks the
   dashboard has not changed since the card was made (`updatedAt`), and re-parses every widget.
   A dashboard from another chat cannot be changed here. The tool refuses it and says so.
3. **A new chat makes a new project.** `create_dashboard` is refused in a chat that already saved one,
   unless `separate: true` is passed. The prompt tells the model to pass that only when the person asks
   for another, separate project.
4. **Colours** (`dashboard.theme`, jsonb, nullable; migration 0055): `{ colors: ['#RRGGBB', …1–6] }`,
   used only when the person names colours. The first is the accent. Null = the console's own palette.
   A colour too pale to see on a white card is refused. They are applied as CSS custom properties
   (`--chart-1…6`) scoped to that dashboard. Semantic colours (up/down, live dot) do not change.
5. **Tables** in tiles become stacked label/value rows under 640 px instead of a 56 rem sideways scroll.

## Alternatives

- A `conversation_id` column on `dashboard`: duplicates what the approved card already records.
- Let any chat change any dashboard: the user asked for the chat that made it. A new chat is a new
  project.

## Consequences

Prompt `assistant@v23`. `proposed_action_tool_check` gains `update_dashboard` (0055). Order on deploy:
apply 0055 before the code (the code selects `theme`).
