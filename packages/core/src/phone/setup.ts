import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { contact, membership, phoneAccount, phoneCall, phoneNumber, user, type Db, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor } from '../permissions';
import { decryptToken, encryptToken, tokenKeysFromEnv, type TokenKeys } from '../integrations/crypto';
import { ProviderError } from '../integrations/provider-http';
import { auPhoneKey } from '../contacts/phone';
import { displayAu, isAuMobile, toAuE164, webhookUrl } from './format';
import { phoneStubEnabled, stubTwilioClient, twilioClient, type KycStatus, type TwilioApi, type TwilioCreds } from './twilio';

/**
 * Phone & SMS setup (ADR 0070): the agency connects its own Twilio, Twilio checks the business, the
 * owner gets each agent a number, and each agent verifies their mobile and turns on forwarding.
 * Every decision is can()'s; every Twilio call happens before (never inside) a transaction.
 */

export class PhoneError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found' | 'invalid' | 'not_configured' | 'provider',
    message: string,
  ) {
    super(message);
    this.name = 'PhoneError';
  }
}

export type PhoneDeps = {
  /** INTEGRATION_TOKEN_KEY: encrypts the API secret and signs the webhook URLs. Null = not configured. */
  keys: TokenKeys | null;
  client: (creds: TwilioCreds) => TwilioApi;
  /** The web app's public https URL Twilio calls back on. */
  webhookBase: string | null;
};

export function phoneDepsFromEnv(env: NodeJS.ProcessEnv = process.env): PhoneDeps {
  let keys: TokenKeys | null = null;
  try {
    keys = tokenKeysFromEnv(env);
  } catch {
    keys = null;
  }
  return {
    keys,
    client: phoneStubEnabled(env) ? () => stubTwilioClient() : (creds) => twilioClient(creds),
    webhookBase: env.PHONE_WEBHOOK_BASE?.trim() || env.NEXT_PUBLIC_WEB_URL?.trim() || null,
  };
}

function agencyOf(actor: Actor, action: 'phone:manage' | 'phone:read'): string {
  if (!actor.agencyId || !can(actor, action, { type: 'phone', agencyId: actor.agencyId })) {
    throw new PhoneError('forbidden', action === 'phone:manage' ? "Only the agency's owners and admins can change the phone setup." : 'You do not have access to the phone setup.');
  }
  return actor.agencyId;
}

function needKeys(deps: PhoneDeps): TokenKeys {
  if (!deps.keys) throw new PhoneError('not_configured', 'Phone & SMS is not set up on this server yet (INTEGRATION_TOKEN_KEY is missing).');
  return deps.keys;
}

function needBase(deps: PhoneDeps): string {
  if (!deps.webhookBase) throw new PhoneError('not_configured', 'Phone & SMS is not set up on this server yet (PHONE_WEBHOOK_BASE is missing).');
  return deps.webhookBase;
}

/** A Twilio failure in words a person can act on — never the key, never Twilio's body. */
export function providerFailure(err: unknown, refused: string): PhoneError {
  if (err instanceof PhoneError) return err;
  if (err instanceof ProviderError && (err.kind === 'unauthorized' || err.status === 403)) return new PhoneError('provider', refused);
  if (err instanceof ProviderError && err.kind === 'rate_limited') return new PhoneError('provider', 'Twilio is busy. Try again in a minute.');
  console.error('[phone] twilio call failed', err instanceof Error ? err.message : err);
  return new PhoneError('provider', 'Twilio could not be reached or refused the request. Try again in a minute.');
}

// ── Connect ─────────────────────────────────────────────────────────────────

const connectSchema = z.object({
  accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'The Account SID starts with AC and has 34 characters.'),
  apiKeySid: z.string().trim().regex(/^SK[0-9a-fA-F]{32}$/, 'The API key SID starts with SK and has 34 characters.'),
  apiKeySecret: z.string().trim().min(16, 'Paste the API key’s secret.').max(128),
});
export type ConnectTwilioInput = z.input<typeof connectSchema>;

export async function connectTwilio(db: Db, actor: Actor, input: ConnectTwilioInput, deps: PhoneDeps): Promise<{ kycStatus: KycStatus }> {
  const agencyId = agencyOf(actor, 'phone:manage');
  const keys = needKeys(deps);
  // The dev stub takes anything, so the screens can be clicked through before a real key exists.
  const probe = deps.client({ accountSid: '', apiKeySid: '', apiKeySecret: '' });
  const parsed = probe.stub
    ? { success: true as const, data: { accountSid: input.accountSid.trim() || 'ACstub', apiKeySid: input.apiKeySid.trim() || 'SKstub', apiKeySecret: input.apiKeySecret.trim() || 'stub' } }
    : connectSchema.safeParse(input);
  if (!parsed.success) throw new PhoneError('invalid', parsed.error.issues[0]?.message ?? 'Check the three values.');
  const creds = parsed.data;
  const client = deps.client(creds);
  let friendlyName: string | null;
  let kyc: Awaited<ReturnType<TwilioApi['kyc']>>;
  try {
    friendlyName = (await client.account()).friendlyName;
    kyc = await client.kyc();
  } catch (err) {
    throw providerFailure(err, 'Twilio did not accept this key. Check the Account SID, the API key SID and its secret.');
  }
  const [existing] = await db.select({ id: phoneAccount.id }).from(phoneAccount).where(eq(phoneAccount.agencyId, agencyId)).limit(1);
  const id = existing?.id ?? randomUUID();
  const values = {
    accountSid: creds.accountSid,
    apiKeySid: creds.apiKeySid,
    apiKeySecret: encryptToken(creds.apiKeySecret, { rowId: id, column: 'twilio_api_secret' }, keys),
    friendlyName,
    kycStatus: kyc.status,
    bundleSid: kyc.bundleSid,
    kycNote: kyc.note,
    kycCheckedAt: new Date(),
    status: 'connected',
    error: null,
    connectedBy: actor.userId,
  };
  await db
    .insert(phoneAccount)
    .values({ id, agencyId, ...values })
    .onConflictDoUpdate({ target: phoneAccount.agencyId, set: { ...values, updatedAt: sql`now()` } });
  return { kycStatus: kyc.status };
}

/**
 * Disconnect: the key is forgotten and the agents' numbers stop working here. The numbers stay on
 * the agency's Twilio account (release them first, or in Twilio, so they stop costing).
 */
export async function disconnectTwilio(db: Db, actor: Actor): Promise<void> {
  const agencyId = agencyOf(actor, 'phone:manage');
  await db.transaction(async (tx) => {
    await tx.update(phoneNumber).set({ status: 'released', updatedAt: sql`now()` }).where(and(eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.status, 'active')));
    await tx.delete(phoneAccount).where(eq(phoneAccount.agencyId, agencyId));
  });
}

type AccountRow = typeof phoneAccount.$inferSelect;

/** The agency's Twilio and a client for it, or a refusal saying to connect it. */
export async function agencyTwilio(db: DbOrTx, agencyId: string, deps: PhoneDeps): Promise<{ account: AccountRow; client: TwilioApi }> {
  const keys = needKeys(deps);
  const [account] = await db.select().from(phoneAccount).where(eq(phoneAccount.agencyId, agencyId)).limit(1);
  if (!account) throw new PhoneError('not_found', "The agency's Twilio is not connected yet. An owner or admin connects it in Connectors → Phone & SMS.");
  let secret: string;
  try {
    secret = decryptToken(account.apiKeySecret, { rowId: account.id, column: 'twilio_api_secret' }, keys);
  } catch {
    throw new PhoneError('not_configured', "The agency's Twilio key can't be read on this server. Connect it again.");
  }
  return { account, client: deps.client({ accountSid: account.accountSid, apiKeySid: account.apiKeySid, apiKeySecret: secret }) };
}

async function saveKyc(db: DbOrTx, accountId: string, kyc: Awaited<ReturnType<TwilioApi['kyc']>>) {
  await db
    .update(phoneAccount)
    .set({ kycStatus: kyc.status, bundleSid: kyc.bundleSid, kycNote: kyc.note, kycCheckedAt: new Date(), status: 'connected', error: null, updatedAt: sql`now()` })
    .where(eq(phoneAccount.id, accountId));
}

/** "Check now" on the setup page. */
export async function refreshKyc(db: Db, actor: Actor, deps: PhoneDeps): Promise<{ kycStatus: KycStatus }> {
  const agencyId = agencyOf(actor, 'phone:manage');
  const { account, client } = await agencyTwilio(db, agencyId, deps);
  let kyc: Awaited<ReturnType<TwilioApi['kyc']>>;
  try {
    kyc = await client.kyc();
  } catch (err) {
    throw providerFailure(err, 'Twilio no longer accepts the saved key. Connect it again with a new API key.');
  }
  await saveKyc(db, account.id, kyc);
  return { kycStatus: kyc.status };
}

/**
 * For the tick: accounts still waiting on Twilio, each checked at most once an hour. A key Twilio now
 * refuses marks the account `error` so the owner sees it. Returns how many were checked.
 */
export async function refreshDueKyc(db: Db, deps: PhoneDeps, now = new Date(), limit = 5): Promise<{ checked: number; approved: number; failed: number }> {
  const report = { checked: 0, approved: 0, failed: 0 };
  if (!deps.keys) return report;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const due = await db
    .select({ agencyId: phoneAccount.agencyId, id: phoneAccount.id })
    .from(phoneAccount)
    .where(and(eq(phoneAccount.status, 'connected'), inArray(phoneAccount.kycStatus, ['unknown', 'none', 'pending', 'needs_fix']), or(isNull(phoneAccount.kycCheckedAt), lt(phoneAccount.kycCheckedAt, hourAgo))))
    .limit(limit);
  for (const a of due) {
    report.checked += 1;
    try {
      const { client } = await agencyTwilio(db, a.agencyId, deps);
      const kyc = await client.kyc();
      await saveKyc(db, a.id, kyc);
      if (kyc.status === 'approved') report.approved += 1;
    } catch (err) {
      report.failed += 1;
      const refused = err instanceof ProviderError && (err.kind === 'unauthorized' || err.status === 403);
      await db
        .update(phoneAccount)
        .set({ kycCheckedAt: now, ...(refused ? { status: 'error', error: 'Twilio refused the saved API key. Connect it again.' } : {}), updatedAt: sql`now()` })
        .where(eq(phoneAccount.id, a.id));
    }
  }
  return report;
}

// ── The setup view ──────────────────────────────────────────────────────────

export type PhoneNumberView = {
  id: string;
  e164: string;
  display: string;
  callerId: string | null;
  callerIdStatus: 'none' | 'pending' | 'verified';
  forwardingTestedAt: Date | null;
  /** Verified and forwarding tested: missed calls reach us. */
  live: boolean;
};

export type PhoneSetupView = {
  /** False when this server can't hold a Twilio key yet. */
  configured: boolean;
  canManage: boolean;
  account: {
    friendlyName: string | null;
    accountSidHint: string;
    kycStatus: KycStatus;
    kycNote: string | null;
    kycCheckedAt: Date | null;
    status: 'connected' | 'error';
    error: string | null;
    connectedAt: Date;
  } | null;
  agents: { userId: string; name: string; mobile: string | null; number: PhoneNumberView | null }[];
};

function numberView(n: typeof phoneNumber.$inferSelect): PhoneNumberView {
  const callerIdStatus = (['none', 'pending', 'verified'] as const).find((s) => s === n.callerIdStatus) ?? 'none';
  return {
    id: n.id,
    e164: n.e164,
    display: displayAu(n.e164),
    callerId: n.callerIdE164 ? displayAu(n.callerIdE164) : null,
    callerIdStatus,
    forwardingTestedAt: n.forwardingTestedAt,
    live: callerIdStatus === 'verified' && Boolean(n.forwardingTestedAt),
  };
}

export async function getPhoneSetup(db: DbOrTx, actor: Actor, deps: Pick<PhoneDeps, 'keys'>): Promise<PhoneSetupView> {
  const agencyId = agencyOf(actor, 'phone:read');
  const canManage = can(actor, 'phone:manage', { type: 'phone', agencyId });
  const [account] = await db.select().from(phoneAccount).where(eq(phoneAccount.agencyId, agencyId)).limit(1);
  // Owners and admins see every member who may text; anyone else only themselves.
  const people = await db
    .select({ userId: user.id, name: sql<string>`coalesce(${user.name}, ${user.email})`, phone: user.phone, role: membership.role })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, agencyId), eq(membership.status, 'active'), ...(canManage ? [] : [eq(membership.userId, actor.userId)])))
    .orderBy(sql`coalesce(${user.name}, ${user.email})`);
  const numbers = await db
    .select()
    .from(phoneNumber)
    .where(and(eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.status, 'active'), ...(canManage ? [] : [eq(phoneNumber.userId, actor.userId)])));
  const byUser = new Map(numbers.map((n) => [n.userId, n]));
  return {
    configured: Boolean(deps.keys),
    canManage,
    account: account
      ? {
          friendlyName: account.friendlyName,
          accountSidHint: `${account.accountSid.slice(0, 2)}…${account.accountSid.slice(-4)}`,
          kycStatus: account.kycStatus as KycStatus,
          kycNote: account.kycNote,
          kycCheckedAt: account.kycCheckedAt,
          status: account.status === 'error' ? 'error' : 'connected',
          error: account.error,
          connectedAt: account.createdAt,
        }
      : null,
    agents: people
      .filter((p) => p.role !== 'read_only')
      .map((p) => {
        const n = byUser.get(p.userId);
        return { userId: p.userId, name: p.name, mobile: p.phone ? displayAu(toAuE164(p.phone) ?? p.phone) : null, number: n ? numberView(n) : null };
      }),
  };
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/** Buys an Australian mobile number on the agency's Twilio for one agent, with its webhooks set. */
export async function getNumberForAgent(db: Db, actor: Actor, agentUserId: string, deps: PhoneDeps): Promise<PhoneNumberView> {
  const agencyId = agencyOf(actor, 'phone:manage');
  const keys = needKeys(deps);
  const base = needBase(deps);
  const { account, client } = await agencyTwilio(db, agencyId, deps);
  if (account.kycStatus !== 'approved' || !account.bundleSid) throw new PhoneError('invalid', 'Twilio has not approved the business yet, so it will not give out Australian numbers.');
  const [member] = await db
    .select({ role: membership.role, phone: user.phone })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, agencyId), eq(membership.userId, agentUserId), eq(membership.status, 'active')))
    .limit(1);
  if (!member || member.role === 'read_only') throw new PhoneError('not_found', 'That person is not an active member who can text.');
  const [has] = await db.select({ id: phoneNumber.id }).from(phoneNumber).where(and(eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.userId, agentUserId), eq(phoneNumber.status, 'active'))).limit(1);
  if (has) throw new PhoneError('invalid', 'They already have a number.');

  const id = randomUUID();
  let bought: { sid: string; e164: string };
  try {
    const e164 = await client.findMobileNumber();
    if (!e164) throw new PhoneError('provider', 'Twilio has no Australian mobile numbers to offer right now. Try again later.');
    bought = await client.buyNumber({ e164, bundleSid: account.bundleSid, smsUrl: webhookUrl(base, id, 'sms', keys), voiceUrl: webhookUrl(base, id, 'voice', keys) });
  } catch (err) {
    throw providerFailure(err, 'Twilio refused to give out a number with the saved key.');
  }
  const mobile = toAuE164(member.phone);
  try {
    const [row] = await db
      .insert(phoneNumber)
      .values({ id, agencyId, userId: agentUserId, e164: bought.e164, numberSid: bought.sid, callerIdE164: isAuMobile(mobile) ? mobile : null })
      .returning();
    return numberView(row!);
  } catch (err) {
    // Somebody else got them a number at the same moment: give this one back.
    await client.releaseNumber(bought.sid).catch(() => undefined);
    throw err;
  }
}

/** Gives a number back to Twilio. Its texts stay in the history. */
export async function releaseAgentNumber(db: Db, actor: Actor, numberId: string, deps: PhoneDeps): Promise<void> {
  const agencyId = agencyOf(actor, 'phone:manage');
  const [n] = await db.select().from(phoneNumber).where(and(eq(phoneNumber.id, numberId), eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.status, 'active'))).limit(1);
  if (!n) throw new PhoneError('not_found', 'That number is not active here.');
  const { client } = await agencyTwilio(db, agencyId, deps);
  try {
    await client.releaseNumber(n.numberSid);
  } catch (err) {
    throw providerFailure(err, 'Twilio refused to release the number with the saved key.');
  }
  await db.update(phoneNumber).set({ status: 'released', updatedAt: sql`now()` }).where(eq(phoneNumber.id, n.id));
}

// ── One agent's phone side ──────────────────────────────────────────────────

/** The actor's own active number, checked as theirs. */
export async function myNumber(db: DbOrTx, actor: Actor): Promise<typeof phoneNumber.$inferSelect> {
  if (!actor.agencyId) throw new PhoneError('forbidden', 'You are not in an agency.');
  const [n] = await db
    .select()
    .from(phoneNumber)
    .where(and(eq(phoneNumber.agencyId, actor.agencyId), eq(phoneNumber.userId, actor.userId), eq(phoneNumber.status, 'active')))
    .limit(1);
  if (!n) throw new PhoneError('not_found', 'You have no phone number yet. An owner or admin gets you one in Connectors → Phone & SMS.');
  if (!can(actor, 'phone:own', { type: 'phone_number', agencyId: n.agencyId, ownerId: n.userId })) throw new PhoneError('forbidden', 'You may not change this number.');
  return n;
}

export type MyPhoneView = {
  configured: boolean;
  connected: boolean;
  kycStatus: KycStatus | null;
  number: PhoneNumberView | null;
  /** The mobile from the person's profile, as a starting value. */
  profileMobile: string | null;
  lastTest: { status: 'calling' | 'passed' | 'failed'; at: Date } | null;
};

const TEST_WAIT_MS = 3 * 60 * 1000;

export async function getMyPhone(db: DbOrTx, actor: Actor, deps: Pick<PhoneDeps, 'keys'>): Promise<MyPhoneView> {
  const agencyId = agencyOf(actor, 'phone:read');
  const [account] = await db.select({ kycStatus: phoneAccount.kycStatus }).from(phoneAccount).where(eq(phoneAccount.agencyId, agencyId)).limit(1);
  const [me] = await db.select({ phone: user.phone }).from(user).where(eq(user.id, actor.userId)).limit(1);
  const [n] = await db.select().from(phoneNumber).where(and(eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.userId, actor.userId), eq(phoneNumber.status, 'active'))).limit(1);
  let lastTest: MyPhoneView['lastTest'] = null;
  if (n) {
    const [t] = await db
      .select({ status: phoneCall.status, at: phoneCall.createdAt })
      .from(phoneCall)
      .where(and(eq(phoneCall.phoneNumberId, n.id), eq(phoneCall.kind, 'test')))
      .orderBy(desc(phoneCall.createdAt))
      .limit(1);
    if (t) {
      // A test nobody heard back from in three minutes did not reach us.
      const status = t.status === 'passed' ? 'passed' : t.status === 'calling' && Date.now() - t.at.getTime() < TEST_WAIT_MS ? 'calling' : 'failed';
      lastTest = { status, at: t.at };
    }
  }
  const profile = toAuE164(me?.phone);
  return {
    configured: Boolean(deps.keys),
    connected: Boolean(account),
    kycStatus: (account?.kycStatus as KycStatus | undefined) ?? null,
    number: n ? numberView(n) : null,
    profileMobile: isAuMobile(profile) ? displayAu(profile) : null,
    lastTest,
  };
}

/** Starts Twilio's caller-ID check on the agent's mobile; returns the code they key in when it calls. */
export async function startCallerIdCheck(db: Db, actor: Actor, mobileRaw: string, deps: PhoneDeps): Promise<{ code: string | null; verified: boolean }> {
  const n = await myNumber(db, actor);
  const e164 = toAuE164(mobileRaw);
  if (!isAuMobile(e164)) throw new PhoneError('invalid', 'Enter your Australian mobile number (04…).');
  const keys = needKeys(deps);
  const { client } = await agencyTwilio(db, n.agencyId, deps);
  const [me] = await db.select({ name: sql<string>`coalesce(${user.name}, ${user.email})` }).from(user).where(eq(user.id, actor.userId)).limit(1);
  let code: string | null = null;
  let verified = false;
  try {
    code = (await client.startCallerId({ e164: e164!, name: me?.name ?? 'Agent', statusUrl: deps.webhookBase ? webhookUrl(deps.webhookBase, n.id, 'caller-id', keys) : null })).validationCode;
  } catch (err) {
    // Twilio refuses a number it has already verified: that is a success, not an error.
    verified = await client.isCallerIdVerified(e164!).catch(() => false);
    if (!verified) throw providerFailure(err, 'Twilio refused to check the number with the saved key.');
  }
  await db
    .update(phoneNumber)
    .set({ callerIdE164: e164, callerIdStatus: verified ? 'verified' : 'pending', callerIdCheckedAt: new Date(), updatedAt: sql`now()` })
    .where(eq(phoneNumber.id, n.id));
  return { code, verified };
}

/** Asks Twilio whether the mobile is verified now (the page polls this while the agent keys the code). */
export async function refreshCallerId(db: Db, actor: Actor, deps: PhoneDeps): Promise<{ status: 'none' | 'pending' | 'verified' }> {
  const n = await myNumber(db, actor);
  if (!n.callerIdE164) return { status: 'none' };
  if (n.callerIdStatus === 'verified') return { status: 'verified' };
  const { client } = await agencyTwilio(db, n.agencyId, deps);
  const ok = await client.isCallerIdVerified(n.callerIdE164).catch(() => false);
  if (ok) await db.update(phoneNumber).set({ callerIdStatus: 'verified', callerIdCheckedAt: new Date(), updatedAt: sql`now()` }).where(eq(phoneNumber.id, n.id));
  return { status: ok ? 'verified' : 'pending' };
}

/**
 * Calls the agent's mobile from their Twilio number. If their no-answer forwarding works, the call
 * comes back to that same number and the voice webhook marks the test passed.
 */
export async function startForwardingTest(db: Db, actor: Actor, deps: PhoneDeps): Promise<{ status: 'calling' | 'passed' }> {
  const n = await myNumber(db, actor);
  if (!n.callerIdE164) throw new PhoneError('invalid', 'Verify your mobile first: the test calls it.');
  const { client } = await agencyTwilio(db, n.agencyId, deps);
  let sid: string;
  try {
    sid = (await client.placeTestCall({ from: n.e164, to: n.callerIdE164 })).sid;
  } catch (err) {
    throw providerFailure(err, 'Twilio refused to place the test call with the saved key.');
  }
  // The dev stub has no phone network: its test passes at once.
  const status = client.stub ? 'passed' : 'calling';
  await db.transaction(async (tx) => {
    await tx.insert(phoneCall).values({ agencyId: n.agencyId, phoneNumberId: n.id, kind: 'test', callSid: sid, fromE164: n.e164, status });
    if (status === 'passed') await tx.update(phoneNumber).set({ forwardingTestedAt: new Date(), updatedAt: sql`now()` }).where(eq(phoneNumber.id, n.id));
  });
  return { status };
}

// ── A domain cutover ────────────────────────────────────────────────────────

/**
 * Every active number, in every agency, pointed at this server's webhook URLs (PHONE_WEBHOOK_BASE).
 * A number keeps the URLs it was bought with, so after the web domain changes Twilio would keep
 * calling the old one: run this (`phone:repoint`) right after the cutover. A platform job — no actor;
 * the CLI is the door. One agency's failure does not stop the rest.
 */
export async function repointNumberWebhooks(db: Db, deps: PhoneDeps): Promise<{ agencies: number; numbers: number; failed: { agencyId: string; error: string }[] }> {
  const keys = needKeys(deps);
  const base = needBase(deps);
  const report = { agencies: 0, numbers: 0, failed: [] as { agencyId: string; error: string }[] };
  const accounts = await db.select({ agencyId: phoneAccount.agencyId }).from(phoneAccount).where(eq(phoneAccount.status, 'connected'));
  for (const a of accounts) {
    report.agencies += 1;
    try {
      const { client } = await agencyTwilio(db, a.agencyId, deps);
      const nums = await db
        .select({ id: phoneNumber.id, sid: phoneNumber.numberSid })
        .from(phoneNumber)
        .where(and(eq(phoneNumber.agencyId, a.agencyId), eq(phoneNumber.status, 'active')));
      for (const n of nums) {
        await client.setNumberWebhooks(n.sid, { smsUrl: webhookUrl(base, n.id, 'sms', keys), voiceUrl: webhookUrl(base, n.id, 'voice', keys) });
        report.numbers += 1;
      }
    } catch (err) {
      report.failed.push({ agencyId: a.agencyId, error: providerFailure(err, 'Twilio refused the saved key.').message });
    }
  }
  return report;
}

// ── Shared lookups ──────────────────────────────────────────────────────────

/** The agency's contact with this phone number, if exactly one is clear (oldest live one wins). */
export async function contactByPhone(db: DbOrTx, agencyId: string, e164: string): Promise<{ id: string; name: string } | null> {
  const key = auPhoneKey(e164);
  if (!key) return null;
  const [c] = await db
    .select({ id: contact.id, name: contact.name })
    .from(contact)
    .where(and(eq(contact.agencyId, agencyId), eq(contact.phoneKey, key), isNull(contact.archivedAt), isNull(contact.mergedIntoId)))
    .orderBy(contact.createdAt)
    .limit(1);
  return c ?? null;
}

/** Where a person's console shows texts: the agency console for owners and admins, the agent desk otherwise. */
export function textsPathFor(role: string | null | undefined): string {
  return isAgencyAdminRole(role as never) ? '/inbox/texts' : '/my-inbox/texts';
}
