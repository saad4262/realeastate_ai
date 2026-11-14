import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { contact, membership, phoneAccount, phoneCall, phoneNumber, user, type Db, type DbOrTx, type PreviousWebhooks } from '@repo/db';
import { can, isAgencyAdminRole, type Actor } from '../permissions';
import { decryptToken, encryptToken, tokenKeysFromEnv, type TokenKeys } from '../integrations/crypto';
import { ProviderError } from '../integrations/provider-http';
import { auPhoneKey } from '../contacts/phone';
import { displayAu, isAuMobile, toAuE164, webhookUrl } from './format';
import { phoneStubEnabled, stubTwilioClient, twilioClient, type KycStatus, type NumberRouting, type TwilioApi, type TwilioCreds, type TwilioOwnedNumber } from './twilio';

/**
 * Phone & SMS setup (ADR 0070): the agency connects its own Twilio, Twilio checks the business, the
 * owner gets each agent a number, and each agent verifies their mobile and turns on forwarding.
 * ADR 0087: an agent may instead connect their own Twilio and get or bring a number on it. Every call
 * about a number uses the account the number lives on (`numberTwilio`).
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

/** The actor's agency, for their own Twilio (ADR 0087): `phone:own` on themselves, never anyone else's. */
function ownAgency(actor: Actor): string {
  if (!actor.agencyId || !can(actor, 'phone:own', { type: 'phone_account', agencyId: actor.agencyId, ownerId: actor.userId })) {
    throw new PhoneError('forbidden', 'You may not connect a Twilio account here.');
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

/** The agency's Twilio, connected by an owner or admin. */
export async function connectTwilio(db: Db, actor: Actor, input: ConnectTwilioInput, deps: PhoneDeps): Promise<{ kycStatus: KycStatus }> {
  return saveAccount(db, actor, agencyOf(actor, 'phone:manage'), null, input, deps);
}

/** The actor's own Twilio (ADR 0087): theirs to connect, and nobody else's to use. */
export async function connectMyTwilio(db: Db, actor: Actor, input: ConnectTwilioInput, deps: PhoneDeps): Promise<{ kycStatus: KycStatus }> {
  return saveAccount(db, actor, ownAgency(actor), actor.userId, input, deps);
}

/** Which account a row is: the agency's (owner null) or one member's own. */
function whose(agencyId: string, ownerUserId: string | null) {
  return and(eq(phoneAccount.agencyId, agencyId), ownerUserId ? eq(phoneAccount.ownerUserId, ownerUserId) : isNull(phoneAccount.ownerUserId));
}

async function saveAccount(db: Db, actor: Actor, agencyId: string, ownerUserId: string | null, input: ConnectTwilioInput, deps: PhoneDeps): Promise<{ kycStatus: KycStatus }> {
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
  const [existing] = await db.select({ id: phoneAccount.id }).from(phoneAccount).where(whose(agencyId, ownerUserId)).limit(1);
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
  // A select then a write, not an upsert: the two partial unique indexes (ADR 0087) are not a target
  // ON CONFLICT can name without repeating their predicates, and they still refuse a duplicate.
  if (existing) await db.update(phoneAccount).set({ ...values, updatedAt: sql`now()` }).where(eq(phoneAccount.id, id));
  else await db.insert(phoneAccount).values({ id, agencyId, ownerUserId, ...values });
  return { kycStatus: kyc.status };
}

/**
 * Disconnect: the key is forgotten and the numbers on that account stop working here. They stay on
 * the Twilio account (release them first, or in Twilio, so they stop costing). Only that account's
 * numbers: the agency disconnecting leaves its agents' own Twilio alone, and the reverse.
 */
async function forgetAccount(db: Db, agencyId: string, ownerUserId: string | null, deps: PhoneDeps): Promise<{ notRestored: string[] }> {
  // ADR 0090: before the key is forgotten, numbers taken over get their old routing back — best effort,
  // since a key that no longer works is a common reason to disconnect. Network before the transaction.
  const notRestored: string[] = [];
  const [acct] = await db.select().from(phoneAccount).where(whose(agencyId, ownerUserId)).limit(1);
  const taken = acct
    ? await db
        .select({ sid: phoneNumber.numberSid, e164: phoneNumber.e164, prev: phoneNumber.previousWebhooks })
        .from(phoneNumber)
        .where(and(eq(phoneNumber.accountId, acct.id), eq(phoneNumber.status, 'active'), isNotNull(phoneNumber.previousWebhooks)))
    : [];
  if (taken.length) {
    let client: TwilioApi | null = null;
    try {
      client = clientFor(acct, deps, 'gone').client;
    } catch {
      client = null;
    }
    for (const t of taken) {
      try {
        if (!client || !t.prev) throw new Error('no client');
        await restoreRouting(client, t.sid, t.prev);
      } catch {
        notRestored.push(displayAu(t.e164));
      }
    }
  }
  await db.transaction(async (tx) => {
    const [account] = await tx.select({ id: phoneAccount.id }).from(phoneAccount).where(whose(agencyId, ownerUserId)).limit(1);
    if (!account) return;
    await tx.update(phoneNumber).set({ status: 'released', updatedAt: sql`now()` }).where(and(eq(phoneNumber.accountId, account.id), eq(phoneNumber.status, 'active')));
    await tx.delete(phoneAccount).where(eq(phoneAccount.id, account.id));
  });
  return { notRestored };
}

/** `notRestored`: numbers whose old routing Twilio would not take back — the owner sets them in Twilio. */
export async function disconnectTwilio(db: Db, actor: Actor, deps: PhoneDeps): Promise<{ notRestored: string[] }> {
  return forgetAccount(db, agencyOf(actor, 'phone:manage'), null, deps);
}

/** The actor's own Twilio: forgotten here; its numbers are theirs (a brought one gets its old routing back). */
export async function disconnectMyTwilio(db: Db, actor: Actor, deps: PhoneDeps): Promise<{ notRestored: string[] }> {
  return forgetAccount(db, ownAgency(actor), actor.userId, deps);
}

type AccountRow = typeof phoneAccount.$inferSelect;
export type TwilioFor = { account: AccountRow; client: TwilioApi };

function clientFor(account: AccountRow | undefined, deps: PhoneDeps, missing: string): TwilioFor {
  const keys = needKeys(deps);
  if (!account) throw new PhoneError('not_found', missing);
  let secret: string;
  try {
    secret = decryptToken(account.apiKeySecret, { rowId: account.id, column: 'twilio_api_secret' }, keys);
  } catch {
    throw new PhoneError('not_configured', "The saved Twilio key can't be read on this server. Connect it again.");
  }
  return { account, client: deps.client({ accountSid: account.accountSid, apiKeySid: account.apiKeySid, apiKeySecret: secret }) };
}

/** The agency's Twilio and a client for it, or a refusal saying to connect it. */
export async function agencyTwilio(db: DbOrTx, agencyId: string, deps: PhoneDeps): Promise<TwilioFor> {
  const [account] = await db.select().from(phoneAccount).where(whose(agencyId, null)).limit(1);
  return clientFor(account, deps, "The agency's Twilio is not connected yet. An owner or admin connects it in Connectors → Phone & SMS.");
}

/** One member's own Twilio (ADR 0087), or a refusal saying to connect it. */
async function ownTwilio(db: DbOrTx, agencyId: string, userId: string, deps: PhoneDeps): Promise<TwilioFor> {
  const [account] = await db.select().from(phoneAccount).where(whose(agencyId, userId)).limit(1);
  return clientFor(account, deps, 'Your own Twilio is not connected. Connect it on My phone first.');
}

/**
 * The Twilio a number lives on — the agency's, or its agent's own (ADR 0087). Every call about a
 * number (a text, a missed-call text, the caller ID check, the forwarding test) goes through this, so
 * a number is never driven with another account's key.
 */
export async function numberTwilio(db: DbOrTx, n: { accountId: string | null }, deps: PhoneDeps): Promise<TwilioFor> {
  const [account] = n.accountId ? await db.select().from(phoneAccount).where(eq(phoneAccount.id, n.accountId)).limit(1) : [];
  return clientFor(account, deps, "This number's Twilio is not connected any more.");
}

async function saveKyc(db: DbOrTx, accountId: string, kyc: Awaited<ReturnType<TwilioApi['kyc']>>) {
  await db
    .update(phoneAccount)
    .set({ kycStatus: kyc.status, bundleSid: kyc.bundleSid, kycNote: kyc.note, kycCheckedAt: new Date(), status: 'connected', error: null, updatedAt: sql`now()` })
    .where(eq(phoneAccount.id, accountId));
}

/** "Check now" on the setup page. */
export async function refreshKyc(db: Db, actor: Actor, deps: PhoneDeps): Promise<{ kycStatus: KycStatus }> {
  return checkKyc(db, await agencyTwilio(db, agencyOf(actor, 'phone:manage'), deps));
}

/** "Check now" on My phone, for the actor's own Twilio. */
export async function refreshMyKyc(db: Db, actor: Actor, deps: PhoneDeps): Promise<{ kycStatus: KycStatus }> {
  return checkKyc(db, await ownTwilio(db, ownAgency(actor), actor.userId, deps));
}

async function checkKyc(db: Db, { account, client }: TwilioFor): Promise<{ kycStatus: KycStatus }> {
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
    .select()
    .from(phoneAccount)
    .where(and(eq(phoneAccount.status, 'connected'), inArray(phoneAccount.kycStatus, ['unknown', 'none', 'pending', 'needs_fix']), or(isNull(phoneAccount.kycCheckedAt), lt(phoneAccount.kycCheckedAt, hourAgo))))
    .limit(limit);
  // Every account, the agency's and its agents' own alike (ADR 0087).
  for (const a of due) {
    report.checked += 1;
    try {
      const { client } = clientFor(a, deps, 'gone');
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
  /** On the agent's own Twilio (ADR 0087), not the agency's: only the agent may stop using it. */
  onOwnTwilio: boolean;
  /** ADR 0090: was on the account before it was used here — releasing puts its old settings back and keeps it in Twilio. */
  hadBefore: boolean;
};

export type TwilioAccountView = {
  friendlyName: string | null;
  accountSidHint: string;
  kycStatus: KycStatus;
  kycNote: string | null;
  kycCheckedAt: Date | null;
  status: 'connected' | 'error';
  error: string | null;
  connectedAt: Date;
};

export type PhoneSetupView = {
  /** False when this server can't hold a Twilio key yet. */
  configured: boolean;
  canManage: boolean;
  /** The agency's own Twilio. */
  account: TwilioAccountView | null;
  /** `ownTwilio`: the agent connected a Twilio of their own (ADR 0087) — shown, never usable by the agency. */
  agents: { userId: string; name: string; mobile: string | null; number: PhoneNumberView | null; ownTwilio: boolean }[];
};

function accountView(account: AccountRow): TwilioAccountView {
  return {
    friendlyName: account.friendlyName,
    accountSidHint: `${account.accountSid.slice(0, 2)}…${account.accountSid.slice(-4)}`,
    kycStatus: account.kycStatus as KycStatus,
    kycNote: account.kycNote,
    kycCheckedAt: account.kycCheckedAt,
    status: account.status === 'error' ? 'error' : 'connected',
    error: account.error,
    connectedAt: account.createdAt,
  };
}

/** `agencyAccountId`: the agency's account, so a number on any other account reads as the agent's own. */
function numberView(n: typeof phoneNumber.$inferSelect, agencyAccountId: string | null): PhoneNumberView {
  const callerIdStatus = (['none', 'pending', 'verified'] as const).find((s) => s === n.callerIdStatus) ?? 'none';
  return {
    id: n.id,
    e164: n.e164,
    display: displayAu(n.e164),
    callerId: n.callerIdE164 ? displayAu(n.callerIdE164) : null,
    callerIdStatus,
    forwardingTestedAt: n.forwardingTestedAt,
    live: callerIdStatus === 'verified' && Boolean(n.forwardingTestedAt),
    onOwnTwilio: Boolean(n.accountId) && n.accountId !== agencyAccountId,
    hadBefore: Boolean(n.previousWebhooks),
  };
}

export async function getPhoneSetup(db: DbOrTx, actor: Actor, deps: Pick<PhoneDeps, 'keys'>): Promise<PhoneSetupView> {
  const agencyId = agencyOf(actor, 'phone:read');
  const canManage = can(actor, 'phone:manage', { type: 'phone', agencyId });
  const accounts = await db.select().from(phoneAccount).where(eq(phoneAccount.agencyId, agencyId));
  const account = accounts.find((a) => a.ownerUserId === null);
  const ownTwilio = new Set(accounts.flatMap((a) => (a.ownerUserId ? [a.ownerUserId] : [])));
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
    account: account ? accountView(account) : null,
    agents: people
      .filter((p) => p.role !== 'read_only')
      .map((p) => {
        const n = byUser.get(p.userId);
        return {
          userId: p.userId,
          name: p.name,
          mobile: p.phone ? displayAu(toAuE164(p.phone) ?? p.phone) : null,
          number: n ? numberView(n, account?.id ?? null) : null,
          ownTwilio: ownTwilio.has(p.userId),
        };
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
  const member = await textingMember(db, agencyId, agentUserId);

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
      .values({ id, agencyId, userId: agentUserId, accountId: account.id, e164: bought.e164, numberSid: bought.sid, callerIdE164: isAuMobile(mobile) ? mobile : null })
      .returning();
    return numberView(row!, account.id);
  } catch (err) {
    // Somebody else got them a number at the same moment: give this one back.
    await client.releaseNumber(bought.sid).catch(() => undefined);
    throw err;
  }
}

/** ADR 0090: the mobiles already on the agency's BYO Twilio, free to give an agent instead of buying one. */
export async function listAgencyTwilioNumbers(db: Db, actor: Actor, deps: PhoneDeps): Promise<ExistingTwilioNumber[]> {
  const agencyId = agencyOf(actor, 'phone:manage');
  const { client } = await agencyTwilio(db, agencyId, deps);
  try {
    return (await existingNumbers(db, client)).offered;
  } catch (err) {
    throw providerFailure(err, 'Twilio refused to list the agency’s numbers with the saved key.');
  }
}

/**
 * ADR 0090: gives an agent a number the agency already has on its Twilio. Its routing is saved and
 * put back when it is released here; the number itself is never given back to Twilio. No bundle check:
 * the number exists, so Twilio has already accepted it on this account.
 */
export async function assignAgencyTwilioNumber(db: Db, actor: Actor, agentUserId: string, numberSid: string, deps: PhoneDeps): Promise<PhoneNumberView> {
  const agencyId = agencyOf(actor, 'phone:manage');
  needKeys(deps);
  needBase(deps);
  const member = await textingMember(db, agencyId, agentUserId);
  const { account, client } = await agencyTwilio(db, agencyId, deps);
  const mobile = toAuE164(member.phone);
  const row = await takeOverNumber(db, client, numberSid, { agencyId, userId: agentUserId, accountId: account.id, callerIdE164: isAuMobile(mobile) ? mobile : null }, deps, 'Twilio refused to point the number here with the saved key.');
  return numberView(row, account.id);
}

/** An active member who may text and has no number yet, or a refusal. */
async function textingMember(db: DbOrTx, agencyId: string, userId: string): Promise<{ phone: string | null }> {
  const [member] = await db
    .select({ role: membership.role, phone: user.phone })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, agencyId), eq(membership.userId, userId), eq(membership.status, 'active')))
    .limit(1);
  if (!member || member.role === 'read_only') throw new PhoneError('not_found', 'That person is not an active member who can text.');
  if (await hasNumber(db, agencyId, userId)) throw new PhoneError('invalid', 'They already have a number.');
  return member;
}

/** Stops using one of the agency's numbers here (ADR 0090: given back to Twilio only if bought here). Its texts stay in the history. */
export async function releaseAgentNumber(db: Db, actor: Actor, numberId: string, deps: PhoneDeps): Promise<void> {
  const agencyId = agencyOf(actor, 'phone:manage');
  const [n] = await db.select().from(phoneNumber).where(and(eq(phoneNumber.id, numberId), eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.status, 'active'))).limit(1);
  if (!n) throw new PhoneError('not_found', 'That number is not active here.');
  const { account, client } = await agencyTwilio(db, agencyId, deps);
  // ADR 0087: an agent's own number is theirs. The agency may not give it back to Twilio.
  if (n.accountId !== account.id) throw new PhoneError('forbidden', 'That number is on the agent’s own Twilio. Only they can stop using it, on My phone.');
  try {
    // ADR 0090: a number the agency had before is its own to keep: its old routing goes back, and it
    // is not given back to Twilio. One bought here is released.
    if (n.previousWebhooks) await restoreRouting(client, n.numberSid, n.previousWebhooks);
    else await client.releaseNumber(n.numberSid);
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
  if (!n) throw new PhoneError('not_found', 'You have no phone number yet. Connect your own Twilio on My phone, or ask an owner or admin for one of the agency’s numbers.');
  if (!can(actor, 'phone:own', { type: 'phone_number', agencyId: n.agencyId, ownerId: n.userId })) throw new PhoneError('forbidden', 'You may not change this number.');
  return n;
}

export type MyPhoneView = {
  configured: boolean;
  /** The agency's Twilio is connected, and its business check. */
  connected: boolean;
  kycStatus: KycStatus | null;
  /** May connect a Twilio of their own (ADR 0087). */
  canConnectOwn: boolean;
  /** Their own Twilio, if connected. */
  own: TwilioAccountView | null;
  number: PhoneNumberView | null;
  /** The mobile from the person's profile, as a starting value. */
  profileMobile: string | null;
  lastTest: { status: 'calling' | 'passed' | 'failed'; at: Date } | null;
};

const TEST_WAIT_MS = 3 * 60 * 1000;

export async function getMyPhone(db: DbOrTx, actor: Actor, deps: Pick<PhoneDeps, 'keys'>): Promise<MyPhoneView> {
  const agencyId = agencyOf(actor, 'phone:read');
  // The agency's account and the actor's own, nobody else's.
  const accounts = await db
    .select()
    .from(phoneAccount)
    .where(and(eq(phoneAccount.agencyId, agencyId), or(isNull(phoneAccount.ownerUserId), eq(phoneAccount.ownerUserId, actor.userId))));
  const account = accounts.find((a) => a.ownerUserId === null);
  const own = accounts.find((a) => a.ownerUserId === actor.userId);
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
    canConnectOwn: can(actor, 'phone:own', { type: 'phone_account', agencyId, ownerId: actor.userId }),
    own: own ? accountView(own) : null,
    number: n ? numberView(n, account?.id ?? null) : null,
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
  const { client } = await numberTwilio(db, n, deps);
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
  const { client } = await numberTwilio(db, n, deps);
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
  const { client } = await numberTwilio(db, n, deps);
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

// ── A number on the agent's own Twilio (ADR 0087) ───────────────────────────

/** The actor's active number here, from any account: still one per agent. */
async function hasNumber(db: DbOrTx, agencyId: string, userId: string): Promise<boolean> {
  const [n] = await db.select({ id: phoneNumber.id }).from(phoneNumber).where(and(eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.userId, userId), eq(phoneNumber.status, 'active'))).limit(1);
  return Boolean(n);
}

const ONE_NUMBER = 'You already have a number here. Stop using it first (or ask an owner or admin to release the agency’s).';

async function saveOwnNumber(db: Db, actor: Actor, agencyId: string, accountId: string, id: string, bought: { sid: string; e164: string }): Promise<PhoneNumberView> {
  const [me] = await db.select({ phone: user.phone }).from(user).where(eq(user.id, actor.userId)).limit(1);
  const mobile = toAuE164(me?.phone);
  const [row] = await db
    .insert(phoneNumber)
    .values({ id, agencyId, userId: actor.userId, accountId, e164: bought.e164, numberSid: bought.sid, callerIdE164: isAuMobile(mobile) ? mobile : null })
    .returning();
  return numberView(row!, null);
}

/** Buys an Australian mobile number on the actor's own Twilio, once Twilio approved their bundle. */
export async function buyMyNumber(db: Db, actor: Actor, deps: PhoneDeps): Promise<PhoneNumberView> {
  const agencyId = ownAgency(actor);
  const keys = needKeys(deps);
  const base = needBase(deps);
  const { account, client } = await ownTwilio(db, agencyId, actor.userId, deps);
  if (account.kycStatus !== 'approved' || !account.bundleSid) throw new PhoneError('invalid', 'Twilio has not approved your documents yet, so it will not give out Australian numbers.');
  if (await hasNumber(db, agencyId, actor.userId)) throw new PhoneError('invalid', ONE_NUMBER);
  const id = randomUUID();
  let bought: { sid: string; e164: string };
  try {
    const e164 = await client.findMobileNumber();
    if (!e164) throw new PhoneError('provider', 'Twilio has no Australian mobile numbers to offer right now. Try again later.');
    bought = await client.buyNumber({ e164, bundleSid: account.bundleSid, smsUrl: webhookUrl(base, id, 'sms', keys), voiceUrl: webhookUrl(base, id, 'voice', keys) });
  } catch (err) {
    throw providerFailure(err, 'Twilio refused to give out a number with your key.');
  }
  try {
    return await saveOwnNumber(db, actor, agencyId, account.id, id, bought);
  } catch (err) {
    await client.releaseNumber(bought.sid).catch(() => undefined);
    throw err;
  }
}

// ── Numbers already on a BYO account (ADR 0087 for an agent's own, ADR 0090 for the agency's) ──

/** A number already on a Twilio account, offered to use here. `unavailable`: why it cannot be, or null. */
export type ExistingTwilioNumber = { sid: string; e164: string; display: string; unavailable: string | null };
/** ADR 0087's name for it, kept for the agent's screen. */
export type OwnTwilioNumber = ExistingTwilioNumber;

/**
 * Why a number Twilio routes some other way is not taken over, or null when it can be. We only ever
 * change a number's two URLs and their methods; a trunk, a TwiML App or a Messaging Service would keep
 * answering instead of us (half taken over), so such a number is refused with what to change. Pure.
 */
export function takeoverRefusal(n: TwilioOwnedNumber, serviceRouted: ReadonlySet<string>): string | null {
  if (n.routing.trunkSid) return 'Its calls go to a SIP trunk in Twilio. Take it off the trunk first.';
  if (n.routing.voiceApplicationSid || n.routing.smsApplicationSid) return 'A TwiML App in Twilio answers it. Clear the app on the number first.';
  if (serviceRouted.has(n.sid)) return 'A Messaging Service in Twilio answers its texts. Take it out of the service, or set the service to use the number’s own webhook.';
  return null;
}

/** One of our own webhook URLs, on any domain we have had (a number used here before). */
const OUR_WEBHOOK = /\/api\/phone\/twilio\/[^/]+\/(sms|voice)$/;

/**
 * What to put back when the number stops being used here (ADR 0090). Our own URL from an earlier use
 * here is not kept: it would point at a row that is no longer active. Pure.
 */
export function routingToSave(r: NumberRouting, now: Date): PreviousWebhooks {
  const keep = (url: string | null) => (url && !OUR_WEBHOOK.test(url) ? url : null);
  const smsUrl = keep(r.smsUrl);
  const voiceUrl = keep(r.voiceUrl);
  return { smsUrl, smsMethod: smsUrl ? r.smsMethod : null, voiceUrl, voiceMethod: voiceUrl ? r.voiceMethod : null, savedAt: now.toISOString() };
}

/** The number's routing put back as it was found. An empty URL clears ours. */
async function restoreRouting(client: TwilioApi, numberSid: string, prev: PreviousWebhooks): Promise<void> {
  await client.setNumberWebhooks(numberSid, {
    smsUrl: prev.smsUrl ?? '',
    voiceUrl: prev.voiceUrl ?? '',
    smsMethod: prev.smsMethod ?? undefined,
    voiceMethod: prev.voiceMethod ?? undefined,
  });
}

/** The mobiles on an account (by Twilio's word, now), each with why it may not be used here. */
async function existingNumbers(db: DbOrTx, client: TwilioApi): Promise<{ offered: ExistingTwilioNumber[]; bySid: Map<string, TwilioOwnedNumber> }> {
  const mobiles = (await client.listNumbers()).filter((n) => isAuMobile(n.e164));
  if (mobiles.length === 0) return { offered: [], bySid: new Map() };
  const [used, serviceRouted] = await Promise.all([
    db.select({ sid: phoneNumber.numberSid }).from(phoneNumber).where(and(inArray(phoneNumber.numberSid, mobiles.map((n) => n.sid)), eq(phoneNumber.status, 'active'))),
    client.serviceRoutedNumberSids(),
  ]);
  const taken = new Set(used.map((u) => u.sid));
  return {
    offered: mobiles
      .filter((n) => !taken.has(n.sid))
      .map((n) => ({ sid: n.sid, e164: n.e164, display: displayAu(n.e164), unavailable: takeoverRefusal(n, serviceRouted) })),
    bySid: new Map(mobiles.map((n) => [n.sid, n])),
  };
}

/**
 * Points an existing number here (ADR 0090): its routing saved first, then its URLs set, then the row.
 * If the row cannot be written, the routing is put back. The number is picked again from Twilio's own
 * list, never taken from the browser alone.
 */
async function takeOverNumber(
  db: Db,
  client: TwilioApi,
  numberSid: string,
  row: { agencyId: string; userId: string; accountId: string; callerIdE164: string | null },
  deps: PhoneDeps,
  refused: string,
): Promise<typeof phoneNumber.$inferSelect> {
  const keys = needKeys(deps);
  const base = needBase(deps);
  let pick: TwilioOwnedNumber | undefined;
  let offered: ExistingTwilioNumber | undefined;
  try {
    const found = await existingNumbers(db, client);
    offered = found.offered.find((n) => n.sid === numberSid);
    pick = found.bySid.get(numberSid);
  } catch (err) {
    throw providerFailure(err, refused);
  }
  if (!offered || !pick) throw new PhoneError('not_found', 'That number is not a mobile free to use on this Twilio.');
  if (offered.unavailable) throw new PhoneError('invalid', offered.unavailable);
  const id = randomUUID();
  const previousWebhooks = routingToSave(pick.routing, new Date());
  try {
    await client.setNumberWebhooks(pick.sid, { smsUrl: webhookUrl(base, id, 'sms', keys), voiceUrl: webhookUrl(base, id, 'voice', keys) });
  } catch (err) {
    throw providerFailure(err, refused);
  }
  try {
    const [saved] = await db
      .insert(phoneNumber)
      .values({ id, ...row, e164: pick.e164, numberSid: pick.sid, previousWebhooks })
      .returning();
    return saved!;
  } catch (err) {
    // Lost a race for the same number: the winner's URLs are on it now, so leave them. Otherwise put
    // back what we found.
    const [winner] = await db.select({ id: phoneNumber.id }).from(phoneNumber).where(and(eq(phoneNumber.numberSid, pick.sid), eq(phoneNumber.status, 'active'))).limit(1);
    if (!winner) await restoreRouting(client, pick.sid, previousWebhooks).catch((e: unknown) => console.error('[phone] routing not put back after a failed save', pick.sid, e instanceof Error ? e.message : e));
    throw err;
  }
}

/** The mobiles already on the actor's own Twilio that are not in use here — the ones they may bring. */
export async function listMyTwilioNumbers(db: Db, actor: Actor, deps: PhoneDeps): Promise<OwnTwilioNumber[]> {
  const agencyId = ownAgency(actor);
  const { client } = await ownTwilio(db, agencyId, actor.userId, deps);
  try {
    return (await existingNumbers(db, client)).offered;
  } catch (err) {
    throw providerFailure(err, 'Twilio refused to list your numbers with your key.');
  }
}

/**
 * Brings a number the actor already has on their own Twilio (ADR 0087): its texts and calls are
 * pointed here, its routing before that saved (ADR 0090). This is how an agent who moves agency
 * keeps their number.
 */
export async function bringMyTwilioNumber(db: Db, actor: Actor, numberSid: string, deps: PhoneDeps): Promise<PhoneNumberView> {
  const agencyId = ownAgency(actor);
  needKeys(deps);
  needBase(deps);
  if (await hasNumber(db, agencyId, actor.userId)) throw new PhoneError('invalid', ONE_NUMBER);
  const { account, client } = await ownTwilio(db, agencyId, actor.userId, deps);
  const [me] = await db.select({ phone: user.phone }).from(user).where(eq(user.id, actor.userId)).limit(1);
  const mobile = toAuE164(me?.phone);
  const row = await takeOverNumber(db, client, numberSid, { agencyId, userId: actor.userId, accountId: account.id, callerIdE164: isAuMobile(mobile) ? mobile : null }, deps, 'Twilio refused to point the number here with your key.');
  return numberView(row, null);
}

/**
 * Stops using the actor's own number here. It stays theirs in Twilio; a number they brought gets its
 * old routing back (ADR 0090) — refused, and still in use here, if Twilio will not take it.
 */
export async function stopUsingMyNumber(db: Db, actor: Actor, deps: PhoneDeps): Promise<void> {
  const n = await myNumber(db, actor);
  const [own] = await db.select({ id: phoneAccount.id }).from(phoneAccount).where(whose(n.agencyId, actor.userId)).limit(1);
  if (!own || n.accountId !== own.id) throw new PhoneError('forbidden', 'This number is the agency’s. An owner or admin releases it.');
  if (n.previousWebhooks) {
    const { client } = await numberTwilio(db, n, deps);
    try {
      await restoreRouting(client, n.numberSid, n.previousWebhooks);
    } catch (err) {
      throw providerFailure(err, 'Twilio refused to put the number’s old settings back with your key.');
    }
  }
  await db.update(phoneNumber).set({ status: 'released', updatedAt: sql`now()` }).where(eq(phoneNumber.id, n.id));
}

/**
 * A member leaves the agency (ADR 0087, decision 3), inside removeMember's transaction: the numbers on
 * their own Twilio are marked `left` — still theirs, no longer here — and that account's key is
 * forgotten. Their texts and calls stay on the agency's record. The agency's own numbers they held
 * are the agency's, untouched. No Twilio call: the webhooks already ignore a number that is not active.
 */
export async function detachLeavingMemberPhone(tx: DbOrTx, agencyId: string, userId: string): Promise<{ numbers: number }> {
  const [own] = await tx.select({ id: phoneAccount.id }).from(phoneAccount).where(whose(agencyId, userId)).limit(1);
  if (!own) return { numbers: 0 };
  const left = await tx
    .update(phoneNumber)
    .set({ status: 'left', updatedAt: sql`now()` })
    .where(and(eq(phoneNumber.accountId, own.id), eq(phoneNumber.status, 'active')))
    .returning({ id: phoneNumber.id });
  await tx.delete(phoneAccount).where(eq(phoneAccount.id, own.id));
  return { numbers: left.length };
}

// ── A domain cutover ────────────────────────────────────────────────────────

/**
 * Every active number, on every account, pointed at this server's webhook URLs (PHONE_WEBHOOK_BASE).
 * A number keeps the URLs it was bought with, so after the web domain changes Twilio would keep
 * calling the old one: run this (`phone:repoint`) right after the cutover. A platform job — no actor;
 * the CLI is the door. One account's failure does not stop the rest. ADR 0087: by account, so an
 * agent's own Twilio is re-pointed with its own key.
 */
export async function repointNumberWebhooks(db: Db, deps: PhoneDeps): Promise<{ accounts: number; numbers: number; failed: { accountId: string; agencyId: string; error: string }[] }> {
  const keys = needKeys(deps);
  const base = needBase(deps);
  const report = { accounts: 0, numbers: 0, failed: [] as { accountId: string; agencyId: string; error: string }[] };
  const accounts = await db.select().from(phoneAccount).where(eq(phoneAccount.status, 'connected'));
  for (const a of accounts) {
    report.accounts += 1;
    try {
      const { client } = clientFor(a, deps, 'gone');
      const nums = await db
        .select({ id: phoneNumber.id, sid: phoneNumber.numberSid })
        .from(phoneNumber)
        .where(and(eq(phoneNumber.accountId, a.id), eq(phoneNumber.status, 'active')));
      for (const n of nums) {
        await client.setNumberWebhooks(n.sid, { smsUrl: webhookUrl(base, n.id, 'sms', keys), voiceUrl: webhookUrl(base, n.id, 'voice', keys) });
        report.numbers += 1;
      }
    } catch (err) {
      report.failed.push({ accountId: a.id, agencyId: a.agencyId, error: providerFailure(err, 'Twilio refused the saved key.').message });
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
