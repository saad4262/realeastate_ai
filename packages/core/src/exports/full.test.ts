import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import type { JobRow } from '../jobs';
import { ExportError } from './quick';

vi.mock('../documents/storage', () => ({
  signDocumentDownload: vi.fn(async (key: string, name: string, seconds: number) => `https://signed.test/${key}?download=${name}&s=${seconds}`),
  putExportObject: vi.fn(),
  downloadDocumentObject: vi.fn(),
  deleteDocumentObject: vi.fn(),
}));

const { documentPath, photoPath, requestFullExport, signExportPart, exportJobHandler, expireExports } = await import('./full');

const A = '11111111-1111-1111-1111-111111111111';
const EXP = '0190a000-0000-7000-8000-0000000000e1';
const owner: Actor = { userId: 'u-owner', agencyId: A, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId: A, membershipRole: 'agent' };
const HOUR = 3_600_000;
const NOW = new Date('2026-11-25T10:00:00Z');

const exportRow = (over: Record<string, unknown> = {}) => ({
  id: EXP, agencyId: A, userId: 'u-agent', status: 'ready', step: 17, cursor: null,
  objects: [`exports/${A}/${EXP}/data.zip`], parts: [{ key: `exports/${A}/${EXP}/data.zip`, name: 'data.zip', bytes: 10 }],
  counts: {}, error: null, finishedAt: NOW, expiresAt: new Date(NOW.getTime() + 24 * HOUR), createdAt: NOW, updatedAt: NOW,
  ...over,
});

/** Each awaited select takes the next queued result; updates are recorded with their SET and WHERE. */
function fakeDb(results: unknown[][]) {
  const dialect = new PgDialect();
  const wheres: string[] = [];
  const updates: { set: Record<string, unknown>; where: { sql: string; params: unknown[] } }[] = [];
  let touched = false;
  const select = () => {
    touched = true;
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) chain[m] = () => chain;
    chain.where = (c: SQL) => (wheres.push(dialect.sqlToQuery(c).sql), chain);
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(res, rej);
    return chain;
  };
  const db = {
    select,
    update: () => ({ set: (set: Record<string, unknown>) => ({ where: async (w: SQL) => void updates.push({ set, where: dialect.sqlToQuery(w) }) }) }),
    transaction: async () => {
      touched = true;
      throw new Error('no transaction in this fake');
    },
  };
  return { db: db as unknown as Db, wheres, updates, touched: () => touched };
}

const job = (attempts = 1): JobRow => ({ id: 'j', agencyId: A, kind: 'data.export', lane: 'bulk', payload: { exportId: EXP }, dedupeKey: null, status: 'running', attempts, maxAttempts: 3, runAt: NOW, claimedAt: NOW, finishedAt: null, lastError: null, createdAt: NOW });

describe('full export (ADR 0104 phase 3)', () => {
  it('refuses an actor with no agency, or a platform view, before touching the database', async () => {
    for (const actor of [{ userId: 'x' }, { ...owner, via: 'platform' as const }] as Actor[]) {
      const f = fakeDb([]);
      await expect(requestFullExport(f.db, actor, NOW)).rejects.toBeInstanceOf(ExportError);
      expect(f.touched()).toBe(false);
    }
  });

  it('signs a 60-second link for the member who asked, only while the export is ready and kept', async () => {
    const ok = fakeDb([[exportRow()]]);
    expect(await signExportPart(ok.db, agent, EXP, 'data.zip', NOW)).toBe(`https://signed.test/exports/${A}/${EXP}/data.zip?download=data.zip&s=60`);
    // The read itself is keyed on the asker: someone else's export id finds nothing.
    expect(ok.wheres[0]).toContain('"user_id" = $');
    const refused: [string, unknown[][], string][] = [
      ['not ready', [[exportRow({ status: 'building' })]], 'data.zip'],
      ['expired', [[exportRow({ expiresAt: new Date(NOW.getTime() - 1) })]], 'data.zip'],
      ['no such part', [[exportRow()]], '../../other.zip'],
      ['someone else’s', [[]], 'data.zip'],
    ];
    for (const [why, rows, name] of refused) {
      await expect(signExportPart(fakeDb(rows).db, agent, EXP, name, NOW), why).rejects.toBeInstanceOf(ExportError);
    }
    const bad = fakeDb([]);
    await expect(signExportPart(bad.db, agent, 'not-a-uuid', 'data.zip', NOW)).rejects.toBeInstanceOf(ExportError);
    expect(bad.touched()).toBe(false);
  });

  it('names files inside the zip from ids, so a title can never climb out of its folder', () => {
    expect(documentPath({ id: 'd1', title: '../../etc/passwd', storageKey: 'agency/x/contract.pdf' })).toBe('documents/d1 etcpasswd.pdf');
    expect(documentPath({ id: 'd2', title: 'Contract of sale.pdf', storageKey: 'a/b/c.PDF' })).toBe('documents/d2 Contract of sale.pdf');
    expect(documentPath({ id: 'd3', title: '///', storageKey: 'a/b/noext' })).toBe('documents/d3 document.bin');
    expect(photoPath({ id: 'm1', listingId: 'l1', storageKey: 'listing/l1/front.webp' })).toBe('photos/l1/m1.webp');
  });

  it('stops an export whose member was removed: its files deleted, marked failed, no next step', async () => {
    const removed: string[] = [];
    const deps = { put: vi.fn(), get: vi.fn(), photo: vi.fn(), remove: async (k: string) => (removed.push(k), true), now: () => NOW };
    // The export row, then memberContext's read: no active membership.
    const f = fakeDb([[exportRow({ status: 'building', step: 3 })], []]);
    await exportJobHandler(deps)(f.db, job());
    expect(removed).toEqual([`exports/${A}/${EXP}/data.zip`]);
    expect(f.updates[0]!.set).toMatchObject({ status: 'failed', error: 'You are no longer a member of this agency', parts: [], objects: [] });
    expect(deps.put).not.toHaveBeenCalled();
  });

  it('leaves a finished or failed export alone if its job runs again', async () => {
    for (const status of ['ready', 'failed', 'expired']) {
      const f = fakeDb([[exportRow({ status })]]);
      await exportJobHandler({ put: vi.fn(), get: vi.fn(), photo: vi.fn(), remove: vi.fn(), now: () => NOW })(f.db, job());
      expect(f.updates).toHaveLength(0);
    }
  });

  it('expires after 24 hours, and keeps the row ready while a file will not delete', async () => {
    const f = fakeDb([[exportRow({ objects: ['exports/a', 'exports/b'] }), exportRow({ id: 'second', objects: ['exports/c'] })]]);
    const r = await expireExports(f.db, { remove: async (k) => k !== 'exports/b', now: () => new Date(NOW.getTime() + 25 * HOUR) });
    expect(r.expired).toBe(1);
    expect(f.updates[0]!.set).toMatchObject({ objects: ['exports/b'] });
    expect(f.updates[0]!.set.status).toBeUndefined();
    expect(f.updates[1]!.set).toMatchObject({ status: 'expired', objects: [], parts: [] });
    // Only ready exports past their time are swept.
    expect(f.wheres[0]).toContain('"status" = $');
    expect(f.wheres[0]).toContain('"expires_at" < $');
  });
});
