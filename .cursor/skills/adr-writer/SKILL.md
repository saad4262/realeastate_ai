---
name: adr-writer
description: >-
  Use when making a significant architecture or product-technical decision
  (new app surface, auth model, data model fork, infra choice) that future
  sessions must understand.
---

# ADR writer

## When

Any decision that would be expensive to reverse or that another tool/session must inherit.

## Format

Create `docs/adr/NNNN-title.md` (next number). Keep ~10 lines:

```markdown
# ADR NNNN — Title

## Context
## Decision
## Alternatives
## Consequences
```

## Rules

1. Write the ADR **before** implementing the change when possible.
2. Link from SESSION.md handoff if the decision was made mid-session.
3. Do not put secrets in ADRs.
