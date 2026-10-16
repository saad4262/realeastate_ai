# 0045 — One console shell; the assistant is each console's home page

**Status:** ACCEPTED, 2026-10-14 (the user: "same design on the agent side, keep the agent's own nav, logic and assistant limits").

## Decision

- **One shell for both consoles.** `components/shell/console-shell.tsx` replaces `(agency)/agency-shell.tsx` and `(agent)/agent-shell.tsx`. What differs between agents.* and agency.* (nav items, home, a few words) is data in `components/shell/surfaces.ts`; the markup and stylesheet exist once (CLAUDE.md #9).
- **The assistant is the home page, not a floating panel.** Agency `/overview`, agent `/assistant` (middleware and `lib/surface.ts` land there). The open conversation is `?c=` (URL is the state, ARCHITECTURE §4); the sidebar's Recents are links to it; "+ New chat" is the home with no `?c=`. On the home itself, switching changes the URL with `pushState` (no page render). The stream reader, selection rule and limits moved unchanged into `useAssistant`.
- **Context still reaches it.** Directory picks travel in the in-browser store (`assistant:open` → `AssistantRoute`); a contact page's "Ask the assistant" opens the home with `?contact=<id>`. The server still checks the actor may see every id.
- **Sidebar:** Recents first, four primary items, the rest behind More (a dot when something there is new).
- **Dashboards are called Projects** (`/projects`, `/my-projects`, a card grid with a drawn thumbnail from `widgetPreview` — shapes and titles only, never figures) and open inside the shell (`/projects/[id]`, `/my-projects/[id]`); `/dashboards/[id]` stays as the full-screen page. **Integrations are called Connectors** (same URLs).

## Unchanged

Every permission (`can()`), every server action and core function, what the assistant may do for whom (server-side, per actor). Visible-text only: the AI's own card text and two server error strings still say "dashboard"/"Integrations".
