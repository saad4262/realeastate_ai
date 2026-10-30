import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { auPhoneKey } from '../contacts/phone';
import type { TokenKeys } from '../integrations/crypto';

/**
 * Pure helpers for Phone & SMS (ADR 0070): number shapes, the carrier's forwarding code, STOP words
 * and the per-number webhook token. No database, no network.
 */

/** An Australian number in E.164 (+61…), or null when it isn't one. Uses the contacts' phone key rule. */
export function toAuE164(raw: string | null | undefined): string | null {
  const key = auPhoneKey(raw);
  if (!key || !/^61\d{9}$/.test(key)) return null;
  return `+${key}`;
}

/** An Australian MOBILE (+614…): the only numbers that can receive a text. */
export function isAuMobile(e164: string | null | undefined): boolean {
  return Boolean(e164 && /^\+614\d{8}$/.test(e164));
}

/** "+61480999888" → "0480 999 888", "+61395551234" → "(03) 9555 1234"; anything else unchanged. */
export function displayAu(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+614(\d{2})(\d{3})(\d{3})$/.exec(e164);
  if (m) return `04${m[1]} ${m[2]} ${m[3]}`;
  const l = /^\+61([2378])(\d{4})(\d{4})$/.exec(e164);
  return l ? `(0${l[1]}) ${l[2]} ${l[3]}` : e164;
}

export const CARRIERS = ['telstra', 'optus', 'vodafone', 'other'] as const;
export type Carrier = (typeof CARRIERS)[number];
export const CARRIER_LABELS: Record<Carrier, string> = { telstra: 'Telstra', optus: 'Optus', vodafone: 'Vodafone', other: 'Other / not sure' };
export const FORWARD_SECONDS = [15, 20, 30] as const;

/**
 * The code an agent dials to forward the calls they don't answer to their Twilio number, and the one
 * to stop it. The GSM "no reply" code, which the three big Australian networks take. PROVISIONAL:
 * each carrier is tried on a real phone before go-live (ROADMAP Phase 3); a carrier that differs gets
 * its own line here.
 */
export function forwardingCodes(_carrier: Carrier, twilioE164: string, seconds: number): { on: string; off: string } {
  const local = displayAu(twilioE164).replace(/\s/g, '') || twilioE164;
  const s = (FORWARD_SECONDS as readonly number[]).includes(seconds) ? seconds : 20;
  return { on: `**61*${local}**${s}#`, off: '##61#' };
}

/** Australia's (and Twilio's) opt-out and opt-in words, matched on the whole message. */
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
export function smsKeyword(body: string): 'stop' | 'start' | null {
  const w = body.trim().toLowerCase().replace(/[.!]+$/, '');
  if (STOP_WORDS.has(w)) return 'stop';
  if (START_WORDS.has(w)) return 'start';
  return null;
}

export const SMS_MAX_LENGTH = 1600;

// ── The webhook token ───────────────────────────────────────────────────────
// Twilio signs its requests with the account's Auth Token, which a bring-your-own API key does not
// give us. So each number's webhook URL carries its own token instead: the number's id and an HMAC of
// it under a key derived from INTEGRATION_TOKEN_KEY. Unguessable, per number, nothing stored.

function webhookKey(keys: TokenKeys): Buffer {
  return Buffer.from(hkdfSync('sha256', keys.current.bytes, Buffer.alloc(0), 'twilio-webhook-v1', 32));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function webhookToken(phoneNumberId: string, keys: TokenKeys): string {
  const sig = createHmac('sha256', webhookKey(keys)).update(`phone-number:${phoneNumberId}`).digest('base64url').slice(0, 32);
  return `${phoneNumberId}.${sig}`;
}

/** The number's id when the token is ours; null for anything else. Constant-time on the signature. */
export function verifyWebhookToken(token: string, keys: TokenKeys): string | null {
  const [id, sig] = token.split('.');
  if (!id || !sig || !UUID.test(id)) return null;
  const want = Buffer.from(webhookToken(id, keys).split('.')[1]!);
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

export type WebhookKind = 'sms' | 'sms-status' | 'voice' | 'caller-id';
export const WEBHOOK_KINDS: readonly WebhookKind[] = ['sms', 'sms-status', 'voice', 'caller-id'];

export function webhookUrl(base: string, phoneNumberId: string, kind: WebhookKind, keys: TokenKeys): string {
  return `${base.replace(/\/+$/, '')}/api/phone/twilio/${webhookToken(phoneNumberId, keys)}/${kind}`;
}

/** TwiML is XML: the few words we put in it are escaped. */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
