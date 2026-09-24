---
name: ai-module-rules
description: >-
  Use when adding or editing any LLM call, prompt, Anthropic SDK usage, AI
  pipeline, enrichment job, or structured AI output in this platform.
---

# AI module rules

## Rules

1. LLM calls **only** inside `packages/ai/`. Never `anthropic.messages.create` (or equivalent) in apps or other packages.
2. Every call goes through `usage.ts` and writes an `ai_run` row (tokens, cost, latency, prompt_version, entity).
3. Prompts live in `prompts/vN.ts` — versioned; do not delete old versions; never inline huge prompts in call sites.
4. Structured outputs always validated with **zod** schemas in `packages/ai/schemas/`.
5. **LLM never produces a number** for prices, medians, days-on-market, estimates. SQL/tools compute; model explains.
6. Never put `new Date()` (or other volatile values) in a system prompt — breaks prompt caching.
7. Bulk enrichment → Batch API (async), not real-time request path.
8. AI listing copy is always a **draft** until human approve.

## Layout

```
packages/ai/
  models.ts, usage.ts, prompts/, tools/, pipelines/, schemas/, evals/
```
