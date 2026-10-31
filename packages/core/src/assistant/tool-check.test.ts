import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every card tool in code can be saved, and the database allows nothing else (found 2026-10-31: `switch_skill`
 * existed in code since ADR 0058 and was never in `proposed_action_tool_check`, so its card could not be saved).
 * The tools in code: every `tool: '…'` in FrozenArgs (actions.ts) and the brief card's (leads/brief-card.ts).
 */
const here = dirname(fileURLToPath(import.meta.url));

function toolsInCode(): string[] {
  const src = readFileSync(resolve(here, 'actions.ts'), 'utf8');
  const union = src.slice(src.indexOf('export type FrozenArgs'), src.indexOf(';\n', src.indexOf("tool: 'propose_ai_brief'")));
  const brief = readFileSync(resolve(here, '../leads/brief-card.ts'), 'utf8').match(/export type SaveBriefArgs = \{ tool: '([a-z_]+)'/)![1]!;
  return [...new Set([...[...union.matchAll(/tool: '([a-z_]+)'/g)].map((m) => m[1]!), brief])].sort();
}

function toolsInCheck(): string[] {
  const dir = resolve(here, '../../../db/drizzle');
  const latest = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().reverse()
    .map((f) => readFileSync(resolve(dir, f), 'utf8'))
    .find((s) => s.includes('ADD CONSTRAINT "proposed_action_tool_check"'))!;
  const list = latest.match(/proposed_action_tool_check" CHECK \(tool IN \(([^)]*)\)\)/)![1]!;
  return list.split(',').map((s) => s.trim().replace(/'/g, '')).sort();
}

describe('the card tools and the database CHECK', () => {
  it('are the same list', () => {
    expect(toolsInCode().length).toBeGreaterThan(30);
    expect(toolsInCheck()).toEqual(toolsInCode());
  });
});
