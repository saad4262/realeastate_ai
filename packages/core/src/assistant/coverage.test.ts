import { describe, expect, it } from 'vitest';
import { coverageLines } from './write-tools';
import { createDashboardInput } from './schema';

/**
 * ADR 0044 A: a dashboard card built from a request of many parts lists every item asked for —
 * in a tile that is really on the dashboard, or "not held". The list cannot name a tile that is
 * not there, so it cannot claim an item is shown when it is not.
 */
describe('coverage on the dashboard card', () => {
  const titles = ['Agents — this month', 'Agency totals'];

  it('each item is a line: where it is shown, or not held', () => {
    const r = coverageLines(
      [
        { asked: 'licence numbers', shown_in: 'agents — this month' },
        { asked: 'sales value this month', shown_in: 'Agency totals' },
        { asked: 'commission earned', shown_in: null },
      ],
      titles,
    );
    expect(r).toEqual({
      ok: true,
      lines: [
        { label: 'You asked for: licence numbers', value: 'Shown in “Agents — this month”' },
        { label: 'You asked for: sales value this month', value: 'Shown in “Agency totals”' },
        { label: 'You asked for: commission earned', value: 'Not held by this account — nothing was estimated' },
      ],
    });
  });

  it('naming a tile that is not on the dashboard is refused, with the real titles', () => {
    const r = coverageLines([{ asked: 'response time', shown_in: 'Response times' }], titles);
    expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(/“Response times”.*The tiles are: “Agents — this month”, “Agency totals”/) });
  });

  it('no coverage, no lines (a single-figure dashboard needs none)', () => {
    expect(coverageLines([], titles)).toEqual({ ok: true, lines: [] });
  });

  it('the tool input takes coverage, strictly', () => {
    const base = { title: 'T', widgets: [{ widget: 'new_leads' }] };
    expect(createDashboardInput.safeParse({ ...base, coverage: [{ asked: 'leads', shown_in: null }] }).success).toBe(true);
    expect(createDashboardInput.safeParse({ ...base, coverage: [{ asked: 'leads' }] }).success).toBe(false);
    expect(createDashboardInput.safeParse({ ...base, coverage: [{ asked: 'leads', shown_in: null, figure: 3 }] }).success).toBe(false);
  });
});
