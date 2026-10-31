import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '@repo/db';
import type { Actor } from '../permissions';
import { pickActive, purposeOf, setActiveProvider } from './choice';
import type { IntegrationProvider } from './providers';

/** ADR 0076: which connected mailbox / calendar is the active one, and who may choose. */

const acc = (...ps: IntegrationProvider[]) => ps.map((provider) => ({ provider }));

describe('the active one', () => {
  it('the only one connected', () => {
    expect(pickActive(acc('outlook_mail'), null, 'mail')?.provider).toBe('outlook_mail');
    expect(pickActive(acc('gmail'), null, 'mail')?.provider).toBe('gmail');
  });
  it('both connected and nothing chosen: Google’s — connecting a second never switches by itself', () => {
    expect(pickActive(acc('outlook_mail', 'gmail'), null, 'mail')?.provider).toBe('gmail');
    expect(pickActive(acc('outlook_calendar', 'google_calendar'), null, 'calendar')?.provider).toBe('google_calendar');
  });
  it('the chosen one while it is connected', () => {
    expect(pickActive(acc('gmail', 'outlook_mail'), 'outlook_mail', 'mail')?.provider).toBe('outlook_mail');
  });
  it('a choice whose account is gone falls to what is left; nothing connected is null', () => {
    expect(pickActive(acc('gmail'), 'outlook_mail', 'mail')?.provider).toBe('gmail');
    expect(pickActive([], 'gmail', 'mail')).toBeNull();
  });
  it('only that purpose’s providers count', () => {
    expect(pickActive(acc('google_calendar', 'zoom'), null, 'mail')).toBeNull();
    expect(pickActive(acc('gmail', 'google_calendar'), null, 'calendar')?.provider).toBe('google_calendar');
  });
  it('knows each provider’s purpose', () => {
    expect([purposeOf('gmail'), purposeOf('outlook_mail'), purposeOf('outlook_calendar'), purposeOf('zoom')]).toEqual(['mail', 'mail', 'calendar', null]);
  });
});

describe('choosing (permission)', () => {
  // A database that must never be reached: every refusal happens before it.
  const untouched = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as DbOrTx;
  const A = 'agency-a';
  const agent: Actor = { userId: 'u-agent', agencyId: A, membershipRole: 'agent' };
  const viewer: Actor = { userId: 'u-view', agencyId: A, membershipRole: 'read_only' };
  const noAgency: Actor = { userId: 'u-x' };
  it('an agent may not choose the agency’s mailbox; a read-only member not even their own', async () => {
    await expect(setActiveProvider(untouched, agent, { provider: 'outlook_mail', ownerType: 'agency' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setActiveProvider(untouched, viewer, { provider: 'outlook_mail', ownerType: 'user' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setActiveProvider(untouched, noAgency, { provider: 'gmail', ownerType: 'user' })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('only a mailbox or a calendar can be the active one', async () => {
    await expect(setActiveProvider(untouched, agent, { provider: 'zoom', ownerType: 'user' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
