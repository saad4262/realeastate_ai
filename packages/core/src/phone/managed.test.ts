import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { decryptToken, encryptToken, tokenKeysFromEnv } from '../integrations/crypto';
import { fakeFetch } from '../integrations/fake-fetch';
import { disconnectTwilio, getNumberForAgent, managedTwilioFromEnv, MANAGED_TEST_NOTE, PhoneError, refreshKyc, startManagedPhone, type ManagedTwilio, type PhoneDeps } from './setup';
import { twilioClient, twilioMasterClient, type TwilioMasterApi } from './twilio';

/** ADR 0090: managed subaccounts, and the test mode that stands in for Twilio's Australian check. */

const keys = tokenKeysFromEnv({ INTEGRATION_TOKEN_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv)!;
const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
const owner = { userId: 'o', agencyId: 'a', membershipRole: 'owner' as const };
const agent = { userId: 's', agencyId: 'a', membershipRole: 'agent' as const };
const masterCreds = { accountSid: `AC${'m'.repeat(32)}`, apiKeySid: `SK${'k'.repeat(32)}`, apiKeySecret: 'master-secret' };

/** A master that records what it was asked, never reaching Twilio. */
function fakeMaster(fail: Partial<Record<keyof Omit<TwilioMasterApi, 'stub'>, boolean>> = {}) {
  const calls: string[] = [];
  const master: TwilioMasterApi = {
    stub: false,
    async createSubaccount(name) {
      calls.push(`create:${name}`);
      if (fail.createSubaccount) throw new Error('refused');
      return { sid: 'ACsub1', authToken: 'sub-token' };
    },
    async createSubaccountKey(sid, token) {
      calls.push(`key:${sid}:${token}`);
      if (fail.createSubaccountKey) throw new Error('refused');
      return { sid: 'SKsub1', secret: 'sub-key-secret' };
    },
    async closeSubaccount(sid) {
      calls.push(`close:${sid}`);
      if (fail.closeSubaccount) throw new Error('refused');
    },
  };
  return { master, calls };
}

/** Selects answer in turn (awaited directly or through .limit); inserts, updates, deletes are recorded. */
function scriptedDb(selects: unknown[][], opts: { insertFails?: boolean } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: unknown[] = [];
  let deletes = 0;
  const next = () => Promise.resolve(selects.shift() ?? []);
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.innerJoin = () => c;
    c.where = () => c;
    c.limit = () => next();
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => next().then(res, rej);
    return c;
  };
  const db: Record<string, unknown> = {
    select: () => chain(),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        if (opts.insertFails) {
          const p = Promise.reject(new Error('duplicate key'));
          return Object.assign(p, { returning: () => p });
        }
        inserts.push(v);
        const row = { callerIdStatus: 'none', forwardingTestedAt: null, previousWebhooks: null, ...v };
        return Object.assign(Promise.resolve(), { returning: async () => [row] });
      },
    }),
    update: () => ({ set: (v: unknown) => ({ where: async () => void updates.push(v) }) }),
    delete: () => ({ where: async () => void deletes++ }),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db: db as unknown as Db, inserts, updates, deletes: () => deletes };
}

const depsWith = (managed: ManagedTwilio | null, f = fakeFetch([])): PhoneDeps => ({ keys, client: (c) => twilioClient(c, f.impl), webhookBase: 'https://site.example', managed });

describe('managed Twilio from env (ADR 0090)', () => {
  const full = { TWILIO_MASTER_ACCOUNT_SID: masterCreds.accountSid, TWILIO_MASTER_API_KEY_SID: masterCreds.apiKeySid, TWILIO_MASTER_API_KEY_SECRET: 'x' };

  it('is offered only with all three master values', () => {
    expect(managedTwilioFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(managedTwilioFromEnv({ ...full, TWILIO_MASTER_API_KEY_SECRET: '' } as NodeJS.ProcessEnv)).toBeNull();
    expect(managedTwilioFromEnv(full as NodeJS.ProcessEnv)).toMatchObject({ testMode: false });
  });

  it('test mode needs its own switch AND US numbers allowed; either alone is not test mode', () => {
    expect(managedTwilioFromEnv({ ...full, PHONE_MANAGED_TEST_MODE: '1' } as NodeJS.ProcessEnv)!.testMode).toBe(false);
    expect(managedTwilioFromEnv({ ...full, PHONE_TEST_COUNTRY_CODES: '1,92' } as NodeJS.ProcessEnv)!.testMode).toBe(false);
    expect(managedTwilioFromEnv({ ...full, PHONE_TEST_COUNTRY_CODES: '92', PHONE_MANAGED_TEST_MODE: '1' } as NodeJS.ProcessEnv)!.testMode).toBe(false);
    expect(managedTwilioFromEnv({ ...full, PHONE_TEST_COUNTRY_CODES: '1,92', PHONE_MANAGED_TEST_MODE: '1' } as NodeJS.ProcessEnv)!.testMode).toBe(true);
  });
});

describe('the master client', () => {
  it('makes a subaccount with the master key, and its key with the subaccount’s own SID and token', async () => {
    const f = fakeFetch([
      { status: 201, body: { sid: 'ACsub1', auth_token: 'sub-token', status: 'active' } },
      { status: 201, body: { sid: 'SKsub1', secret: 'sub-key-secret' } },
      { status: 200, body: { sid: 'ACsub1', status: 'closed' } },
    ]);
    const m = twilioMasterClient(masterCreds, f.impl);
    expect(await m.createSubaccount('agency a')).toEqual({ sid: 'ACsub1', authToken: 'sub-token' });
    expect(await m.createSubaccountKey('ACsub1', 'sub-token', 'LocalAgentHub')).toEqual({ sid: 'SKsub1', secret: 'sub-key-secret' });
    await m.closeSubaccount('ACsub1');
    const basic = (a: string, b: string) => `Basic ${Buffer.from(`${a}:${b}`).toString('base64')}`;
    expect(f.calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts.json');
    expect(f.calls[0]!.headers.authorization).toBe(basic(masterCreds.apiKeySid, masterCreds.apiKeySecret));
    expect(f.calls[1]!.url).toBe('https://iam.twilio.com/v1/Keys');
    // A parent's API key is refused a subaccount's resources: the key is made as the subaccount.
    expect(f.calls[1]!.headers.authorization).toBe(basic('ACsub1', 'sub-token'));
    expect(Object.fromEntries(new URLSearchParams(f.calls[1]!.body))).toMatchObject({ AccountSid: 'ACsub1' });
    expect(f.calls[2]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACsub1.json');
    expect(Object.fromEntries(new URLSearchParams(f.calls[2]!.body))).toEqual({ Status: 'closed' });
  });

  it('looks for a US local number only when asked, and buys it with no bundle', async () => {
    const creds = { accountSid: 'ACsub1', apiKeySid: 'SKsub1', apiKeySecret: 's' };
    const f = fakeFetch([
      { status: 200, body: { available_phone_numbers: [{ phone_number: '+14155550100' }] } },
      { status: 201, body: { sid: 'PN1', phone_number: '+14155550100' } },
    ]);
    const c = twilioClient(creds, f.impl);
    expect(await c.findMobileNumber('US')).toBe('+14155550100');
    await c.buyNumber({ e164: '+14155550100', bundleSid: null, smsUrl: 'https://s/sms', voiceUrl: 'https://s/voice' });
    expect(f.calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACsub1/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&PageSize=1');
    expect(new URLSearchParams(f.calls[1]!.body).has('BundleSid')).toBe(false);
  });
});

describe('starting managed phone numbers', () => {
  it('only an owner or admin, refused before the database or Twilio', async () => {
    const { master, calls } = fakeMaster();
    const err = await startManagedPhone(noDb, agent, depsWith({ master, testMode: true })).catch((e: unknown) => e);
    expect((err as PhoneError).code).toBe('forbidden');
    expect(calls).toHaveLength(0);
  });

  it('says so when this server has no master account', async () => {
    const err = await startManagedPhone(noDb, owner, depsWith(null)).catch((e: unknown) => e);
    expect((err as PhoneError).code).toBe('not_configured');
  });

  it('refuses when the agency already has a Twilio here, before making anything', async () => {
    const { master, calls } = fakeMaster();
    const { db } = scriptedDb([[{ id: 'acct' }]]);
    const err = await startManagedPhone(db, owner, depsWith({ master, testMode: true })).catch((e: unknown) => e);
    expect((err as PhoneError).code).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  it('in test mode: a managed row, approved by us with no bundle and a note saying so, its key encrypted', async () => {
    const { master, calls } = fakeMaster();
    const { db, inserts } = scriptedDb([[]]);
    expect(await startManagedPhone(db, owner, depsWith({ master, testMode: true }))).toEqual({ kycStatus: 'approved' });
    expect(calls).toEqual(['create:agency a', 'key:ACsub1:sub-token']);
    const row = inserts[0]!;
    expect(row).toMatchObject({ kind: 'managed', ownerUserId: null, accountSid: 'ACsub1', apiKeySid: 'SKsub1', kycStatus: 'approved', bundleSid: null, kycNote: MANAGED_TEST_NOTE });
    expect(row.apiKeySecret).not.toBe('sub-key-secret');
    expect(decryptToken(row.apiKeySecret as string, { rowId: row.id as string, column: 'twilio_api_secret' }, keys)).toBe('sub-key-secret');
    // The subaccount's auth token is used once and never kept.
    expect(JSON.stringify(row)).not.toContain('sub-token');
  });

  it('outside test mode: not approved, waiting on the business details', async () => {
    const { master } = fakeMaster();
    const { db, inserts } = scriptedDb([[]]);
    expect(await startManagedPhone(db, owner, depsWith({ master, testMode: false }))).toEqual({ kycStatus: 'none' });
    expect(inserts[0]).toMatchObject({ kycStatus: 'none', bundleSid: null });
  });

  it('closes the new subaccount when its key or its row cannot be made', async () => {
    for (const [fail, insertFails] of [[{ createSubaccountKey: true }, false], [{}, true]] as const) {
      const { master, calls } = fakeMaster(fail);
      const { db } = scriptedDb([[]], { insertFails });
      await expect(startManagedPhone(db, owner, depsWith({ master, testMode: true }))).rejects.toBeTruthy();
      expect(calls.at(-1)).toBe('close:ACsub1');
    }
  });
});

describe('numbers on a managed account', () => {
  const managedRow = (bundleSid: string | null, kind = 'managed') => ({
    id: 'acct',
    agencyId: 'a',
    ownerUserId: null,
    kind,
    accountSid: 'ACsub1',
    apiKeySid: 'SKsub1',
    apiKeySecret: encryptToken('sub-key-secret', { rowId: 'acct', column: 'twilio_api_secret' }, keys),
    kycStatus: 'approved',
    bundleSid,
  });

  it('test mode buys a US number with no bundle', async () => {
    const { master } = fakeMaster();
    const { db, inserts } = scriptedDb([[managedRow(null)], [{ role: 'agent', phone: null }], []]);
    const f = fakeFetch([
      { status: 200, body: { available_phone_numbers: [{ phone_number: '+14155550100' }] } },
      { status: 201, body: { sid: 'PN1', phone_number: '+14155550100' } },
    ]);
    const n = await getNumberForAgent(db, owner, 's', depsWith({ master, testMode: true }, f));
    expect(n.e164).toBe('+14155550100');
    expect(f.calls[0]!.url).toContain('/AvailablePhoneNumbers/US/Local.json');
    expect(new URLSearchParams(f.calls[1]!.body).has('BundleSid')).toBe(false);
    expect(inserts[0]).toMatchObject({ accountId: 'acct', numberSid: 'PN1' });
  });

  it('a test approval buys nothing once test mode is off, and test mode never helps a BYO account', async () => {
    const { master } = fakeMaster();
    for (const [row, testMode] of [[managedRow(null), false], [managedRow(null, 'byo'), true]] as const) {
      const { db } = scriptedDb([[row]]);
      const f = fakeFetch([]);
      const err = await getNumberForAgent(db, owner, 's', depsWith({ master, testMode }, f)).catch((e: unknown) => e);
      expect((err as PhoneError).code).toBe('invalid');
      expect(f.calls).toHaveLength(0);
    }
  });

  it('“Check now” in test mode keeps our approval instead of asking Twilio', async () => {
    const { master } = fakeMaster();
    const { db, updates } = scriptedDb([[managedRow(null)]]);
    const f = fakeFetch([]);
    expect(await refreshKyc(db, owner, depsWith({ master, testMode: true }, f))).toEqual({ kycStatus: 'approved' });
    expect(f.calls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('turning it off closes the subaccount before forgetting it; refused when this server cannot reach ours', async () => {
    const { master, calls } = fakeMaster();
    const run = scriptedDb([[managedRow(null)], [], [{ id: 'acct' }]]);
    await disconnectTwilio(run.db, owner, depsWith({ master, testMode: true }));
    expect(calls).toEqual(['close:ACsub1']);
    expect(run.deletes()).toBe(1);

    const refused = scriptedDb([[managedRow(null)]]);
    const err = await disconnectTwilio(refused.db, owner, depsWith(null)).catch((e: unknown) => e);
    expect((err as PhoneError).code).toBe('not_configured');
    expect(refused.deletes()).toBe(0);

    const { master: failing } = fakeMaster({ closeSubaccount: true });
    const kept = scriptedDb([[managedRow(null)]]);
    await expect(disconnectTwilio(kept.db, owner, depsWith({ master: failing, testMode: true }))).rejects.toBeInstanceOf(PhoneError);
    expect(kept.deletes()).toBe(0);
  });
});
