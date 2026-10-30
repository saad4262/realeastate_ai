import { randomInt } from 'node:crypto';
import { basicAuth, call, form, str, type Fetch } from '../integrations/provider-http';

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

export interface TwilioApi {
  /** True for the dev stub: no call reaches Twilio, a test call passes by itself. */
  readonly stub: boolean;
  /** Checks the key works. */
  account(): Promise<{ friendlyName: string | null }>;
  /** The agency's business verification for Australian mobile numbers. */
  kyc(): Promise<KycResult>;
  /** One Australian mobile number that can text and call, or null when Twilio has none to offer. */
  findMobileNumber(): Promise<string | null>;
  buyNumber(input: { e164: string; bundleSid: string; smsUrl: string; voiceUrl: string }): Promise<{ sid: string; e164: string }>;
  releaseNumber(numberSid: string): Promise<void>;
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

const API = 'https://api.twilio.com/2010-04-01';
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
      const r = await get(`${acct}.json`);
      return { friendlyName: str(r.json?.friendly_name) };
    },
    async kyc() {
      const r = await get(`${NUMBERS}/RegulatoryCompliance/Bundles?IsoCountry=AU&NumberType=mobile&PageSize=20`);
      const results = Array.isArray(r.json?.results) ? (r.json!.results as Record<string, unknown>[]) : [];
      return kycFromBundles(results.map((b) => ({ sid: str(b.sid), status: str(b.status) })));
    },
    async findMobileNumber() {
      const r = await get(`${acct}/AvailablePhoneNumbers/AU/Mobile.json?SmsEnabled=true&VoiceEnabled=true&PageSize=1`);
      const list = Array.isArray(r.json?.available_phone_numbers) ? (r.json!.available_phone_numbers as Record<string, unknown>[]) : [];
      return str(list[0]?.phone_number);
    },
    async buyNumber(input) {
      const r = await post(`${acct}/IncomingPhoneNumbers.json`, {
        PhoneNumber: input.e164,
        BundleSid: input.bundleSid,
        SmsUrl: input.smsUrl,
        SmsMethod: 'POST',
        VoiceUrl: input.voiceUrl,
        VoiceMethod: 'POST',
      });
      const sid = str(r.json?.sid);
      if (!sid) throw new Error('Twilio did not return the new number');
      return { sid, e164: str(r.json?.phone_number) ?? input.e164 };
    },
    async releaseNumber(numberSid) {
      await call(fetchImpl, 'Twilio', `${acct}/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, { method: 'DELETE', headers: auth }, [404]);
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
    async findMobileNumber() {
      return `+61480${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
    },
    async buyNumber(input) {
      return { sid: `PNstub${randomInt(0, 1e9)}`, e164: input.e164 };
    },
    async releaseNumber() {},
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

export function phoneStubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHONE_STUB === '1' && env.NODE_ENV !== 'production';
}
