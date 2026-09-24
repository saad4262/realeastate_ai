---
name: session-handoff
description: >-
  Use at session start or end, when the user says handoff, wrap up, where were
  we, or when switching between Cursor and Claude Code. Maintains shared git
  context so the other tool does not cold-start.
---

# Session handoff (Cursor ↔ Claude Code)

## Session start

1. Read `docs/STATUS.md`
2. Read top 1–2 entries of `docs/SESSION.md`
3. Load any matching skill for the task
4. Then explore code — **do not** full-repo scan by default
5. Do not re-architect from chat memory; trust STATUS/SESSION + ADRs

## Session end / "handoff" / "wrap up"

1. **Overwrite** `docs/STATUS.md` (milestone, done, next, blockers, open decisions, last tool, date)
2. **Append** (newest on top) a `docs/SESSION.md` entry:

```markdown
## YYYY-MM-DD — <Cursor | Claude Code> — <short title>
- Goal:
- Done:
- Files touched:
- Decisions:
- Left unfinished (exact next step):
- Risks / watch:
```

3. If a durable learning appeared → `docs/memory/YYYY-MM-DD-topic.md`
4. Big decision → ADR via `adr-writer` first
5. **Never** put secrets, tokens, or `.env` values in these files

## Tool split reminder

- Cursor → apps/web, apps/console, packages/ui
- Claude Code → packages/db, core, auth, ai
