import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { contrastOnWhite, dashboardThemeSchema, updateDashboard, updateDashboardSchema } from '.';
import { runAssistantTool } from '../assistant/tools';
import type { Actor } from '../permissions';

/**
 * ADR 0047: a dashboard is changed in the chat that made it — by its creator or an admin, never
 * across agencies, never over a change made since the card — and colours too pale to see are refused.
 */

const agencyA = '11111111-1111-1111-1111-111111111111';
const agencyB = '22222222-2222-2222-2222-222222222222';
const dashId = '33333333-3333-3333-3333-333333333333';
const owner: Actor = { userId: 'u-owner', agencyId: agencyA, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId: agencyA, membershipRole: 'agent' };
const otherOwner: Actor = { userId: 'u-other', agencyId: agencyB, membershipRole: 'owner' };
const savedAt = new Date('2026-10-16T01:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: dashId,
    agencyId: agencyA,
    createdBy: 'u-owner',
    title: 'Sales',
    widgets: [{ widget: 'new_leads', params: { range: '7d' } }, { widget: 'sold_count', params: { range: '30d' } }],
    audience: 'agency',
    theme: null,
    archivedAt: null,
    updatedAt: savedAt,
    timeZone: 'Australia/Sydney',
    ...over,
  };
}

/** A db whose every select answers `rows`; updates are recorded, never run. */
function fakeDb(rows: Record<string, unknown>[]) {
  const updates: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  chain.update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        updates.push(values);
        return Promise.resolve();
      },
    }),
  });
  return { db: chain as unknown as Db, updates };
}

describe('dashboard colours', () => {
  it('takes #RRGGBB, stores it lower case, and refuses a colour too pale for a white card', () => {
    expect(dashboardThemeSchema.parse({ colors: ['#1E3A8A', '#b45309'] })).toEqual({ colors: ['#1e3a8a', '#b45309'] });
    expect(dashboardThemeSchema.safeParse({ colors: ['#fff59d'] }).success).toBe(false);
    expect(dashboardThemeSchema.safeParse({ colors: ['navy'] }).success).toBe(false);
    expect(dashboardThemeSchema.safeParse({ colors: [] }).success).toBe(false);
    expect(dashboardThemeSchema.safeParse({ colors: Array(7).fill('#1e3a8a') }).success).toBe(false);
    expect(contrastOnWhite('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastOnWhite('#000000')).toBeCloseTo(21, 5);
  });
  it('a change must change something', () => {
    expect(updateDashboardSchema.safeParse({}).success).toBe(false);
    expect(updateDashboardSchema.safeParse({ theme: null }).success).toBe(true);
  });
});

describe('updateDashboard (core)', () => {
  it('its creator changes it, and only what was asked', async () => {
    const { db, updates } = fakeDb([row()]);
    await updateDashboard(db, owner, dashId, { title: 'Sales and leads', theme: { colors: ['#1e3a8a'] } }, { expectedUpdatedAt: savedAt.toISOString() });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ title: 'Sales and leads', theme: { colors: ['#1e3a8a'] } });
    expect(updates[0]).not.toHaveProperty('widgets');
    expect(updates[0]).not.toHaveProperty('audience');
  });
  it('an agent who can open it, but did not make it, cannot change it', async () => {
    const { db, updates } = fakeDb([row()]);
    await expect(updateDashboard(db, agent, dashId, { title: 'Mine now' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(updates).toHaveLength(0);
  });
  it('an agent who cannot even open it is told it does not exist', async () => {
    const { db, updates } = fakeDb([row({ audience: 'admins' })]);
    await expect(updateDashboard(db, agent, dashId, { title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    expect(updates).toHaveLength(0);
  });
  it('another agency cannot change it (cross-tenant)', async () => {
    const { db, updates } = fakeDb([row()]);
    await expect(updateDashboard(db, otherOwner, dashId, { title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    expect(updates).toHaveLength(0);
  });
  it('a dashboard changed since the card was made is refused, not overwritten', async () => {
    const { db, updates } = fakeDb([row({ updatedAt: new Date('2026-10-16T02:00:00.000Z') })]);
    await expect(updateDashboard(db, owner, dashId, { title: 'x' }, { expectedUpdatedAt: savedAt.toISOString() })).rejects.toMatchObject({ code: 'conflict' });
    expect(updates).toHaveLength(0);
  });
  it('every widget is re-parsed: an unknown widget is refused', async () => {
    const { db, updates } = fakeDb([row()]);
    await expect(updateDashboard(db, owner, dashId, { widgets: [{ widget: 'nope' as never }] })).rejects.toMatchObject({ code: 'invalid' });
    expect(updates).toHaveLength(0);
  });
});

describe('one chat, one dashboard (the assistant)', () => {
  const proposal = { conversationId: '44444444-4444-4444-4444-444444444444', turnId: 't1', toolUseId: 'tu1', made: { count: 0 } };
  const ctx = (db: Db, actor: Actor = owner) => ({ db, actor, timeZone: 'UTC', handles: {}, now: new Date(), proposal });

  it('a chat that already saved a dashboard is told to change it, not to make another', async () => {
    const { db } = fakeDb([row()]);
    const out = await runAssistantTool(ctx(db), 'create_dashboard', { title: 'Sales again', widgets: [{ widget: 'new_leads' }] });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('update_dashboard');
  });
  it('a chat that saved none has nothing to change — a new chat makes a new one', async () => {
    const { db } = fakeDb([]);
    const out = await runAssistantTool(ctx(db), 'update_dashboard', { title: 'x' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('has not saved a dashboard');
  });
  it('keeping a tile that is not there names the tiles that are', async () => {
    const { db } = fakeDb([row()]);
    const out = await runAssistantTool(ctx(db), 'update_dashboard', { widgets: [{ keep: 1 }, { keep: 5 }] });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toMatch(/no tile 5.*1\. /);
  });
  it('an agent cannot change a dashboard this chat could see but they did not make', async () => {
    const { db } = fakeDb([row()]);
    const out = await runAssistantTool(ctx(db, agent), 'update_dashboard', { title: 'x' });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('creator or an admin');
  });
  it('a colour too pale is refused before any card is made', async () => {
    const { db } = fakeDb([row()]);
    const out = await runAssistantTool(ctx(db), 'update_dashboard', { colors: ['#fffde7'] });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('too pale');
  });
});
