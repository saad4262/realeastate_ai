import { describe, expect, it } from 'vitest';
import { PROPERTY_CHAT_V14 } from '../prompts/v14';
import { PROMPT_VERSION, PROPERTY_CHAT_V15 } from '../prompts/v15';
import { dispatchTool, type ToolContext } from './index';

const A = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const B = '7f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const asked: unknown[] = [];
const plan = { day: 'Saturday 14 November', stops: ['9:30 am – 10:00 am: 7 Test Road, Officer.', '10:15 am – 10:45 am: 14 Station Street, Officer (1.2 km in a straight line from the last stop).'], notThisDay: [], planPath: `/inspections?l=${A},${B}&s=x,y`, rules: 'Copy the times and distances exactly. … never estimate a driving time.' };
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    places: new Map(),
    skillBlocks: new Map(),
    scheduling: { state: 'signed_out' },
    inspections: async (ask: { listingIds: string[] }) => (asked.push(ask), ask.listingIds.includes(A) ? plan : null),
    ...over,
  }) as unknown as ToolContext;

describe('plan_inspections (ADR 0080, C6)', () => {
  it('hands over the code-written stops, the plan page and the no-driving-time rule', async () => {
    const out = await dispatchTool('plan_inspections', { listingIds: [A, B], day: '2026-11-14' }, ctx());
    expect(out.result).toMatchObject({ found: true, day: 'Saturday 14 November', stops: plan.stops, planPage: plan.planPath });
    expect(JSON.stringify(out.result)).toMatch(/never estimate a driving time/);
    expect(asked.at(-1)).toEqual({ listingIds: [A, B], day: '2026-11-14' });
  });

  it('nothing public: found false; bad input refused; a day of no open times says so', async () => {
    expect((await dispatchTool('plan_inspections', { listingIds: [B] }, ctx())).result).toMatchObject({ found: false });
    expect((await dispatchTool('plan_inspections', { listingIds: [] }, ctx())).isError).toBe(true);
    expect((await dispatchTool('plan_inspections', { listingIds: [A], day: 'Saturday' }, ctx())).isError).toBe(true);
    const empty = ctx({ inspections: async () => ({ ...plan, stops: [] }) });
    expect(JSON.stringify((await dispatchTool('plan_inspections', { listingIds: [A] }, empty)).result)).toMatch(/no\b.*open-for-inspection time that day|None of these homes has an open-for-inspection time/);
  });

  it('is behind the Inspection AI switch', async () => {
    const off = ctx({ skillBlocks: new Map([['inspection_planner', 'switched_off']]) as never });
    expect(JSON.stringify((await dispatchTool('plan_inspections', { listingIds: [A] }, off)).result)).toMatch(/switched off/);
  });

  it('prompt v15 is v14 plus the tool and its rules, and keeps notes out of the guide', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v15');
    expect(PROPERTY_CHAT_V15).toContain('You have fourteen tools.');
    expect(PROPERTY_CHAT_V15.startsWith(PROPERTY_CHAT_V14.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V15).toMatch(/Never estimate a driving or travel time/);
    expect(PROPERTY_CHAT_V15).toMatch(/You cannot read anyone's inspection notes/);
    expect(PROPERTY_CHAT_V15).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
  });
});
