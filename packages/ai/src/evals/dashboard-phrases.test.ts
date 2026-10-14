import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { catalogForPrompt, tileSpecSchema } from '@repo/core/semantic';
import { WIDGET_IDS, WIDGETS } from '@repo/core/widgets';
import { ASSISTANT_PROMPT_VERSION, ASSISTANT_SYSTEM } from '../prompts/assistant-v18';
import { DASHBOARD_EVALS } from './dashboard-phrases';

/**
 * Offline and free (no model): the golden answers are ones core accepts, and
 * the prompt carries the catalog core enforces. The model's own answers are
 * compared with these only in `pnpm smoke:ai`.
 */
describe('dashboard evals (ADR 0036 Phase 3)', () => {
  it('every expected answer is valid: fixed widgets exist with that range, custom specs parse against the catalog', () => {
    for (const e of DASHBOARD_EVALS) {
      if (e.expect.kind === 'fixed') {
        expect(WIDGET_IDS, e.phrase).toContain(e.expect.widget);
        const def = WIDGETS[e.expect.widget as keyof typeof WIDGETS];
        expect(def.params.safeParse(e.expect.range ? { range: e.expect.range } : {}).success, e.phrase).toBe(true);
      }
      if (e.expect.kind === 'custom') {
        const p = tileSpecSchema.safeParse(e.expect.spec);
        expect(p.success, `${e.phrase}: ${p.success ? '' : p.error.issues[0]?.message}`).toBe(true);
      }
    }
    // Each kind is covered.
    expect(new Set(DASHBOARD_EVALS.map((e) => e.expect.kind))).toEqual(new Set(['fixed', 'custom', 'missing']));
  });

  it('the prompt carries the catalog exactly, and the catalog is pinned to the prompt version', () => {
    expect(ASSISTANT_SYSTEM).toContain(catalogForPrompt());
    // A catalog change changes the prompt: bump ASSISTANT_PROMPT_VERSION and this hash together.
    const hash = createHash('sha256').update(catalogForPrompt()).digest('hex').slice(0, 12);
    expect({ version: ASSISTANT_PROMPT_VERSION, catalog: hash }).toEqual({ version: 'assistant@v18', catalog: hash });
    expect(ASSISTANT_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
