import { randomInt } from 'node:crypto';
import { basicAuth, call, form, ProviderError, str, type Fetch } from '../integrations/provider-http';

/**
 * The agency's own Twilio (ADR 0070), over Twilio's REST API with the API key the owner entered.
 * `fetch` is injected, so the tests run against fakes and never reach Twilio.
 *
 * Every Twilio answer we act on is read through `str()`; nothing from Twilio is trusted as a number or
 * a status without being checked against the few values we know. A failure is a ProviderError whose
 * message never carries the key, the secret or a response body.
 */

export type TwilioCreds = { accountSid: string; apiKeySid: string; apiKeySecret: string };

/** unknown: never checked · none: no documents submitted · pending · needs_fix · approved. */
export type KycStatus = 'unknown' | 'none' | 'pending' | 'needs_fix' | 'approved';
export const KYC_STATUSES: readonly KycStatus[] = ['unknown', 'none', 'pending', 'needs_fix', 'approved'];

export type KycResult = { status: KycStatus; bundleSid: string | null; note: string | null };

export const TRIAL_NOTE =
  'This Twilio account is a free trial, and Twilio does not verify a business on a trial. Upgrade it in Twilio (add billing), then Check now.';

export interface TwilioApi {
  /** True for the dev stub: no call reaches Twilio, a test call passes by itself. */
  readonly stub: boolean;
  /** Checks the key works. */
  account(): Promise<{ friendlyName: string | null }>;
  /** The agency's business verification for Australian mobile numbers. */
  kyc(): Promise<KycResult>;
  /**
   * One number that can text and call, or null when Twilio has none to offer: an Australian mobile, or
   * (ADR 0090 test mode only) a US local number, which needs no bundle.
   */
  findMobileNumber(country?: 'AU' | 'US'): Promise<string | null>;
  /** `bundleSid` null only for a US test number (ADR 0090); every Australian number is bought under one. */
  buyNumber(input: { e164: string; bundleSid: string | null; smsUrl: string; voiceUrl: string }): Promise<{ sid: string; e164: string }>;
  /**
   * The numbers already on this account, with how Twilio routes each today (ADR 0087: an agent brings
   * the one they have; ADR 0090: so does a BYO agency). Up to 1,000.
   */
  listNumbers(): Promise<TwilioOwnedNumber[]>;
  /**
   * ADR 0090: the numbers inside a Messaging Service that answers their texts itself (its inbound
   * setting is not "defer to the number's webhook"): changing such a number's own URL does nothing.
   */
  serviceRoutedNumberSids(): Promise<Set<string>>;
  releaseNumber(numberSid: string): Promise<void>;
  /**
   * Points a number's texts and calls at these URLs (a domain cutover, ADR 0070; a number taken over,
   * ADR 0090). Methods default to POST; an empty URL clears it (putting back a number that had none).
   */
  setNumberWebhooks(numberSid: string, urls: { smsUrl: string; voiceUrl: string; smsMethod?: string; voiceMethod?: string }): Promise<void>;
  sendSms(input: { from: string; to: string; body: string; statusUrl: string | null }): Promise<{ sid: string; status: string }>;
  /** Twilio calls the mobile and asks for the code it returns here, which the person keys in. */
  startCallerId(input: { e164: string; name: string; statusUrl: string | null }): Promise<{ validationCode: string }>;
  isCallerIdVerified(e164: string): Promise<boolean>;
  /** A call from the agent's Twilio number to their mobile that nobody should answer. */
  placeTestCall(input: { from: string; to: string }): Promise<{ sid: string }>;
  /**
   * An Elastic SIP trunk with a credential list, so Retell can place AI calls from this account's
   * numbers (ADR 0072). The numbers are NOT moved onto the trunk: their incoming calls still reach our
   * voice webhook. PROVISIONAL until tried with a real account.
   */
  createSipTrunk(input: { friendlyName: string; domainPrefix: string; username: string; password: string }): Promise<{ trunkSid: string; domain: string }>;
}

/** How Twilio routes a number's texts and calls today. Null where Twilio has nothing ("" included). */
export type NumberRouting = {
  smsUrl: string | null;
  smsMethod: string | null;
  voiceUrl: string | null;
  voiceMethod: string | null;
  /** A TwiML App (AP…) that answers instead of the URLs. */
  smsApplicationSid: string | null;
  voiceApplicationSid: string | null;
  /** An Elastic SIP trunk (TK…) that takes the calls instead of the URLs. */
  trunkSid: string | null;
};

export type TwilioOwnedNumber = { sid: string; e164: string; routing: NumberRouting };

const API = 'https://api.twilio.com/2010-04-01';
const MESSAGING = 'https://messaging.twilio.com/v1';
const NUMBERS = 'https://numbers.twilio.com/v2';
const TRUNKING = 'https://trunking.twilio.com/v1';

/** Twilio bundle statuses → ours. Anything we don't know is "pending" — never "approved". */
export function kycFromBundles(bundles: readonly { sid: string | null; status: string | null }[]): KycResult {
  const approved = bundles.find((b) => b.status === 'twilio-approved' && b.sid);
  if (approved) return { status: 'approved', bundleSid: approved.sid, note: null };
  if (bundles.some((b) => b.status === 'twilio-rejected')) {
    return { status: 'needs_fix', bundleSid: null, note: 'Twilio did not accept the business documents. Open Twilio → Regulatory Compliance to see why and send them again.' };
  }
  if (bundles.some((b) => b.status && ['pending-review', 'in-review', 'provisionally-approved'].includes(b.status))) {
    return { status: 'pending', bundleSid: null, note: null };
  }
  if (bundles.some((b) => b.status === 'draft')) {
    return { status: 'none', bundleSid: null, note: 'The documents are saved in Twilio but not submitted yet.' };
  }
  return { status: 'none', bundleSid: null, note: null };
}

export function twilioClient(creds: TwilioCreds, fetchImpl: Fetch = fetch): TwilioApi {
  const auth = { authorization: basicAuth(creds.apiKeySid, creds.apiKeySecret) };
  const acct = `${API}/Accounts/${encodeURIComponent(creds.accountSid)}`;
  const get = (url: string) => call(fetchImpl, 'Twilio', url, { method: 'GET', headers: auth });
  const post = (url: string, body: Record<string, string | undefined>) =>
    call(fetchImpl, 'Twilio', url, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });

  return {
    stub: false,
    async account() {
      // The account's own numbers, not `${acct}.json`: Twilio refuses the Accounts resource to a
      // Standard API key (70004) — the very key the setup screen asks for — so every connect failed.
      // The account's name is in that resource, so it is not shown; the screen shows the SID's end.
      await get(`${acct}/IncomingPhoneNumbers.json?PageSize=1`);
      return { friendlyName: null };
    },
    async kyc() {
      const url = `${NUMBERS}/RegulatoryCompliance/Bundles?IsoCountry=AU&NumberType=mobile&PageSize=20`;
      const r = await call(fetchImpl, 'Twilio', url, { method: 'GET', headers: auth }, [401]);
      if (r.status === 401) {
        // A trial account is refused bundles with the same 401 and code as a bad key; only the words differ.
        if (/trial account/i.test(str(r.json?.message) ?? '')) return { status: 'none', bundleSid: null, note: TRIAL_NOTE };
        throw new ProviderError('unauthorized', 'Twilio answered 401', 401);
      }
      const results = Array.isArray(r.json?.results) ? (r.json!.results as Record<string, unknown>[]) : [];
      return kycFromBundles(results.map((b) => ({ sid: str(b.sid), status: str(b.status) })));
    },
    async findMobileNumber(country = 'AU') {
      const kind = country === 'US' ? 'US/Local' : 'AU/Mobile';
      const r = await get(`${acct}/AvailablePhoneNumbers/${kind}.json?SmsEnabled=true&VoiceEnabled=true&PageSize=1`);
      const list = Array.isArray(r.json?.available_phone_numbers) ? (r.json!.available_phone_numbers as Record<string, unknown>[]) : [];
      return str(list[0]?.phone_number);
    },
    async buyNumber(input) {
      const r = await post(`${acct}/IncomingPhoneNumbers.json`, {
        PhoneNumber: input.e164,
        BundleSid: input.bundleSid ?? undefined,
        SmsUrl: input.smsUrl,
        SmsMethod: 'POST',
        VoiceUrl: input.voiceUrl,
        VoiceMethod: 'POST',
      });
      const sid = str(r.json?.sid);
      if (!sid) throw new Error('Twilio did not return the new number');
      return { sid, e164: str(r.json?.phone_number) ?? input.e164 };
    },
    async listNumbers() {
      const r = await get(`${acct}/IncomingPhoneNumbers.json?PageSize=1000`);
      const list = Array.isArray(r.json?.incoming_phone_numbers) ? (r.json!.incoming_phone_numbers as Record<string, unknown>[]) : [];
      return list.flatMap((n) => {
        const sid = str(n.sid);
        const e164 = str(n.phone_number);
        if (!sid || !e164) return [];
        const routing: NumberRouting = {
          smsUrl: str(n.sms_url),
          smsMethod: str(n.sms_method),
          voiceUrl: str(n.voice_url),
          voiceMethod: str(n.voice_method),
          smsApplicationSid: str(n.sms_application_sid),
          voiceApplicationSid: str(n.voice_application_sid),
          trunkSid: str(n.trunk_sid),
        };
        return [{ sid, e164, routing }];
      });
    },
    async serviceRoutedNumberSids() {
      // PROVISIONAL until tried with a real account: Messaging Services v1, read 2026-11-14.
      const r = await get(`${MESSAGING}/Services?PageSize=50`);
      const services = Array.isArray(r.json?.services) ? (r.json!.services as Record<string, unknown>[]) : [];
      const sids = new Set<string>();
      for (const svc of services) {
        const id = str(svc.sid);
        // Deferring to the number's webhook leaves the number's own URL in charge: that one is fine.
        if (!id || svc.use_inbound_webhook_on_number === true) continue;
        const p = await get(`${MESSAGING}/Services/${encodeURIComponent(id)}/PhoneNumbers?PageSize=1000`);
        const nums = Array.isArray(p.json?.phone_numbers) ? (p.json!.phone_numbers as Record<string, unknown>[]) : [];
        for (const n of nums) {
          const pn = str(n.sid);
          if (pn) sids.add(pn);
        }
      }
      return sids;
    },
    async releaseNumber(numberSid) {
      await call(fetchImpl, 'Twilio', `${acct}/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, { method: 'DELETE', headers: auth }, [404]);
    },
    async setNumberWebhooks(numberSid, urls) {
      await post(`${acct}/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, {
        SmsUrl: urls.smsUrl,
        SmsMethod: urls.smsMethod ?? 'POST',
        VoiceUrl: urls.voiceUrl,
        VoiceMethod: urls.voiceMethod ?? 'POST',
      });
    },
    async sendSms(input) {
      const r = await post(`${acct}/Messages.json`, { From: input.from, To: input.to, Body: input.body, StatusCallback: input.statusUrl ?? undefined });
      const sid = str(r.json?.sid);
      if (!sid) throw new Error('Twilio did not return the message');
      return { sid, status: str(r.json?.status) ?? 'queued' };
    },
    async startCallerId(input) {
      const r = await post(`${acct}/OutgoingCallerIds.json`, { PhoneNumber: input.e164, FriendlyName: input.name.slice(0, 64), StatusCallback: input.statusUrl ?? undefined });
      const code = str(r.json?.validation_code);
      if (!code) throw new Error('Twilio did not return a code');
      return { validationCode: code };
    },
    async isCallerIdVerified(e164) {
      const r = await get(`${acct}/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(e164)}`);
      return Array.isArray(r.json?.outgoing_caller_ids) && (r.json!.outgoing_caller_ids as unknown[]).length > 0;
    },
    async placeTestCall(input) {
      // Rings for up to 40 s: the agent's no-answer forwarding (15–30 s) passes it to their Twilio number.
      const r = await post(`${acct}/Calls.json`, { From: input.from, To: input.to, Twiml: '<Response><Pause length="1"/><Hangup/></Response>', Timeout: '40' });
      const sid = str(r.json?.sid);
      if (!sid) throw new Error('Twilio did not place the call');
      return { sid };
    },
    async createSipTrunk(input) {
      const trunk = await post(`${TRUNKING}/Trunks`, { FriendlyName: input.friendlyName, DomainName: `${input.domainPrefix}.pstn.twilio.com` });
      const trunkSid = str(trunk.json?.sid);
      const domain = str(trunk.json?.domain_name) ?? `${input.domainPrefix}.pstn.twilio.com`;
      if (!trunkSid) throw new Error('Twilio did not create the trunk');
      const list = await post(`${acct}/SIP/CredentialLists.json`, { FriendlyName: `${input.friendlyName} (AI calls)` });
      const listSid = str(list.json?.sid);
      if (!listSid) throw new Error('Twilio did not create the credential list');
      await post(`${acct}/SIP/CredentialLists/${encodeURIComponent(listSid)}/Credentials.json`, { Username: input.username, Password: input.password });
      await post(`${TRUNKING}/Trunks/${encodeURIComponent(trunkSid)}/CredentialLists`, { CredentialListSid: listSid });
      return { trunkSid, domain };
    },
  };
}

/**
 * A pretend Twilio for development (PHONE_STUB=1, never in production): every step succeeds, so the
 * setup screens and the texts page can be clicked through before the real keys exist. Nothing leaves
 * the machine; a text "sent" here reaches nobody.
 */
export function stubTwilioClient(): TwilioApi {
  return {
    stub: true,
    async account() {
      return { friendlyName: 'Twilio (dev stub)' };
    },
    async kyc() {
      return { status: 'approved', bundleSid: 'BUstub', note: null };
    },
    async findMobileNumber(country = 'AU') {
      return country === 'US' ? `+1415555${String(randomInt(0, 10_000)).padStart(4, '0')}` : `+61480${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
    },
    async buyNumber(input) {
      return { sid: `PNstub${randomInt(0, 1e9)}`, e164: input.e164 };
    },
    async listNumbers() {
      const routing = { smsUrl: null, smsMethod: null, voiceUrl: null, voiceMethod: null, smsApplicationSid: null, voiceApplicationSid: null, trunkSid: null };
      return [{ sid: 'PNstubown1', e164: '+61480000111', routing }];
    },
    async serviceRoutedNumberSids() {
      return new Set<string>();
    },
    async releaseNumber() {},
    async setNumberWebhooks() {},
    async sendSms() {
      return { sid: `SMstub${randomInt(0, 1e9)}`, status: 'sent' };
    },
    async startCallerId() {
      return { validationCode: '123456' };
    },
    async isCallerIdVerified() {
      return true;
    },
    async placeTestCall() {
      return { sid: `CAstub${randomInt(0, 1e9)}` };
    },
    async createSipTrunk(input) {
      return { trunkSid: `TKstub${randomInt(0, 1e9)}`, domain: `${input.domainPrefix}.pstn.twilio.com` };
    },
  };
}

// ── The platform's own Twilio (ADR 0090: managed subaccounts) ────────────────

/**
 * The platform's master account, driven with a Main API key (a Standard key is refused the Accounts
 * resource; Main keys are made only in Twilio's console). A parent's API key is refused a subaccount's
 * own resources, so the subaccount's key is made with the subaccount's SID and auth token, which Twilio
 * returns once, when the subaccount is made; it is used for that one call and never stored.
 * PROVISIONAL until tried with a real master account (Accounts and Keys v1, read 2026-11-14).
 */
export interface TwilioMasterApi {
  readonly stub: boolean;
  createSubaccount(friendlyName: string): Promise<{ sid: string; authToken: string }>;
  /** A Standard key inside the subaccount. Its secret is returned only now. */
  createSubaccountKey(subaccountSid: string, authToken: string, friendlyName: string): Promise<{ sid: string; secret: string }>;
  /** Closed for good: Twilio releases every number on it, and it cannot be reopened. */
  closeSubaccount(subaccountSid: string): Promise<void>;
}

export function twilioMasterClient(creds: TwilioCreds, fetchImpl: Fetch = fetch): TwilioMasterApi {
  const master = { authorization: basicAuth(creds.apiKeySid, creds.apiKeySecret) };
  const post = (url: string, headers: Record<string, string>, body: Record<string, string | undefined>) =>
    call(fetchImpl, 'Twilio', url, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
  return {
    stub: false,
    async createSubaccount(friendlyName) {
      const r = await post(`${API}/Accounts.json`, master, { FriendlyName: friendlyName.slice(0, 64) });
      const sid = str(r.json?.sid);
      const authToken = str(r.json?.auth_token);
      if (!sid || !authToken) throw new Error('Twilio did not return the new subaccount');
      return { sid, authToken };
    },
    async createSubaccountKey(subaccountSid, authToken, friendlyName) {
      const r = await post('https://iam.twilio.com/v1/Keys', { authorization: basicAuth(subaccountSid, authToken) }, { AccountSid: subaccountSid, FriendlyName: friendlyName.slice(0, 64) });
      const sid = str(r.json?.sid);
      const secret = str(r.json?.secret);
      if (!sid || !secret) throw new Error('Twilio did not return the new key');
      return { sid, secret };
    },
    async closeSubaccount(subaccountSid) {
      await post(`${API}/Accounts/${encodeURIComponent(subaccountSid)}.json`, master, { Status: 'closed' });
    },
  };
}

/** The dev stub's master (PHONE_STUB=1): subaccounts that exist nowhere. */
export function stubTwilioMasterClient(): TwilioMasterApi {
  return {
    stub: true,
    async createSubaccount() {
      return { sid: `ACstub${randomInt(0, 1e9)}`, authToken: 'stub-token' };
    },
    async createSubaccountKey() {
      return { sid: `SKstub${randomInt(0, 1e9)}`, secret: 'stub-secret' };
    },
    async closeSubaccount() {},
  };
}

export function phoneStubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHONE_STUB === '1' && env.NODE_ENV !== 'production';
}
