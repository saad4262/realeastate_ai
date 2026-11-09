import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { stopAssistantTask } from './actions';

/** ADR 0088: stopping a long send from the top bar: the same rule as cancelling it in a chat. */

const endTask = vi.hoisted(() => vi.fn(async () => 3));
vi.mock('./task-state', async (real) => ({ ...(await real<object>()), endTask }));

const A = '11111111-1111-1111-1111-111111111111';
const ID = '00000000-0000-4000-8000-000000000001';
const agent: Actor = { userId: 'u1', agencyId: A, membershipRole: 'agent' };
const owner: Actor = { userId: 'boss', agencyId: A, membershipRole: 'owner' };

/** Answers each select in turn, inside the transaction. */
function dbWith(rows: unknown[][]) {
  const chain = (result: unknown[]) => ({ from: () => ({ where: () => ({ limit: async () => result }) }) });
  const tx = { select: () => chain(rows.shift() ?? []) };
  return { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as Db;
}

const task = (over: object = {}) => ({ userId: 'u1', agencyId: A, status: 'active', ...over });

beforeEach(() => vi.clearAllMocks());

describe('stopAssistantTask', () => {
  it('stops the rest of its own task', async () => {
    expect(await stopAssistantTask(dbWith([[task()], []]), agent, ID)).toEqual({ cancelled: 3 });
    expect(endTask).toHaveBeenCalledTimes(1);
  });
  it('an owner or admin may stop an agent’s', async () => {
    await stopAssistantTask(dbWith([[task()], []]), owner, ID);
    expect(endTask).toHaveBeenCalledTimes(1);
  });
  it('another agent may not', async () => {
    await expect(stopAssistantTask(dbWith([[task({ userId: 'someone' })], []]), agent, ID)).rejects.toMatchObject({ code: 'forbidden' });
    expect(endTask).not.toHaveBeenCalled();
  });
  it('a read-only member may not stop even their own', async () => {
    await expect(stopAssistantTask(dbWith([[task()], []]), { ...agent, membershipRole: 'read_only' }, ID)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('another agency’s is not found', async () => {
    await expect(stopAssistantTask(dbWith([[task({ agencyId: 'other' })]]), owner, ID)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('an id that is not one is not found, before any read', async () => {
    await expect(stopAssistantTask(dbWith([]), owner, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('a finished task says so', async () => {
    await expect(stopAssistantTask(dbWith([[task({ status: 'done' })], []]), owner, ID)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('a workflow’s own task is stopped by pausing the workflow, not here', async () => {
    await expect(stopAssistantTask(dbWith([[task()], [{ id: 'p1' }]]), owner, ID)).rejects.toMatchObject({ code: 'conflict' });
    expect(endTask).not.toHaveBeenCalled();
  });
  it('someone with no agency is refused before any read', async () => {
    await expect(stopAssistantTask(dbWith([]), { userId: 'x' }, ID)).rejects.toMatchObject({ code: 'not_found' });
  });
});
