import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import type { TokenKeys } from '../integrations/crypto';
import { call, str, type Fetch } from '../integrations/provider-http';
import { instantForLocalTime, localPartsIn } from '../schedules/next-run';

/**
 * The AI call back's voice side (ADR 0072): the platform's own Retell account places the call, from the
 * agent's Twilio number, through a SIP trunk on the agency's Twilio. Pure helpers here too: calling
 * hours, the decision, Retell's webhook token and signature. `fetch` is injected; tests never reach Retell.
 *
 * PROVISIONAL until tried with a real Retell key: the request shapes follow Retell's API reference
 * (create-phone-call v2, import-phone-number) as read on 2026-10-30.
 */

export type AiCallRequest = {
  fromE164: string;
  toE164: string;
  variables: { agent_first_name: string; agency_name: string; caller_first_name: string };
  /** Read back on the webhook: which of our calls this is. */
  metadata: { phoneCallId: string; agencyId: string };
};

export interface VoiceAi {
  readonly stub: boolean;
  createCall(r: AiCallRequest): Promise<{ callId: string }>;
  /** Makes a Twilio number one Retell can call from, through the agency's SIP trunk. */
  registerNumber(input: { e164: string; terminationUri: string; username: string; password: string; nickname: string }): Promise<void>;
}

const RETELL = 'https://api.retellai.com';

export function retellClient(apiKey: string, agentId: string, fetchImpl: Fetch = fetch): VoiceAi {
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => call(fetchImpl, 'Retell', `${RETELL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return {
    stub: false,
    async createCall(r) {
      const res = await post('/v2/create-phone-call', {
        from_number: r.fromE164,
        to_number: r.toE164,
        override_agent_id: agentId,
        retell_llm_dynamic_variables: r.variables,
        metadata: r.metadata,
      });
      const callId = str(res.json?.call_id);
      if (!callId) throw new Error('Retell did not return a call id');
      return { callId };
    },
    async registerNumber(input) {
      // A number Retell already has answers 409/400: treat as done; anything else throws.
      await post('/import-phone-number', {
        phone_number: input.e164,
        termination_uri: input.terminationUri,
        sip_trunk_auth_username: input.username,
        sip_trunk_auth_password: input.password,
        outbound_agent_id: agentId,
        nickname: input.nickname.slice(0, 60),
      }).catch((err: unknown) => {
        if (err && typeof err === 'object' && 'status' in err && (err as { status: number | null }).status === 409) return;
        throw err;
      });
    },
  };
}

/** A pretend Retell for development (PHONE_STUB=1, never in production): calls "start" and reach nobody. */
export function stubVoiceAi(): VoiceAi {
  return {
    stub: true,
    async createCall() {
      return { callId: `stub_call_${randomInt(0, 1e9)}` };
    },
    async registerNumber() {},
  };
}

export type VoiceConfig = { voice: VoiceAi | null; apiKey: string | null; verifySignature: boolean };

/** Retell when RETELL_API_KEY and RETELL_AGENT_ID are set; the stub under PHONE_STUB=1 (dev); else none. */
export function voiceFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const apiKey = env.RETELL_API_KEY?.trim() || null;
  const agentId = env.RETELL_AGENT_ID?.trim() || null;
  const stub = env.PHONE_STUB === '1' && env.NODE_ENV !== 'production';
  return {
    voice: apiKey && agentId ? retellClient(apiKey, agentId) : stub ? stubVoiceAi() : null,
    apiKey,
    verifySignature: env.RETELL_VERIFY_SIGNATURE === '1',
  };
}

// ── Retell's webhook door ───────────────────────────────────────────────────

function retellKey(keys: TokenKeys): Buffer {
  return Buffer.from(hkdfSync('sha256', keys.current.bytes, Buffer.alloc(0), 'retell-webhook-v1', 32));
}

/** The one token in the platform agent's webhook URL. Only this server can make it. */
export function retellWebhookToken(keys: TokenKeys): string {
  return createHmac('sha256', retellKey(keys)).update('retell-agent-webhook').digest('base64url').slice(0, 40);
}

export function verifyRetellWebhookToken(token: string, keys: TokenKeys): boolean {
  const want = Buffer.from(retellWebhookToken(keys));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function retellWebhookUrl(base: string, keys: TokenKeys): string {
  return `${base.replace(/\/+$/, '')}/api/phone/retell/${retellWebhookToken(keys)}`;
}

/**
 * Retell's own signature, `x-retell-signature: v=<ms>,d=<hex>`: an HMAC-SHA256 under the API key of the
 * raw body followed by the timestamp. Checked only with RETELL_VERIFY_SIGNATURE=1 until it has been
 * seen to match a real delivery; the URL token is always required.
 */
export function verifyRetellSignature(rawBody: string, header: string | null, apiKey: string, now = Date.now()): boolean {
  const m = /^v=(\d+),d=([0-9a-f]+)$/.exec(header ?? '');
  if (!m) return false;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60 * 1000) return false;
  const want = Buffer.from(createHmac('sha256', apiKey).update(rawBody + m[1]).digest('hex'));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ── When the AI may call ────────────────────────────────────────────────────

/** Hours on the agency's clock, [from, to) in whole hours; null = no AI calls that day. */
export type CallingHours = { weekdays: [number, number] | null; saturday: [number, number] | null; sunday: [number, number] | null };
export const DEFAULT_CALLING_HOURS: CallingHours = { weekdays: [8, 20], saturday: [9, 17], sunday: null };

/** A stored value, checked; anything odd is the default. */
export function readCallingHours(v: unknown): CallingHours {
  const pair = (x: unknown): [number, number] | null | undefined => {
    if (x === null) return null;
    if (Array.isArray(x) && x.length === 2 && x.every((n) => Number.isInteger(n) && n >= 0 && n <= 24) && (x[0] as number) < (x[1] as number)) return [x[0] as number, x[1] as number];
    return undefined;
  };
  if (!v || typeof v !== 'object') return DEFAULT_CALLING_HOURS;
  const o = v as Record<string, unknown>;
  const w = pair(o.weekdays);
  const s = pair(o.saturday);
  const u = pair(o.sunday);
  return w === undefined || s === undefined || u === undefined ? DEFAULT_CALLING_HOURS : { weekdays: w, saturday: s, sunday: u };
}

/** The first instant at or after `t` inside the calling hours, or null when there is none in a week. */
export function nextCallableTime(t: Date, hours: CallingHours, timeZone: string): Date | null {
  const p = localPartsIn(t, timeZone);
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const dow = day.getUTCDay();
    const window = dow === 0 ? hours.sunday : dow === 6 ? hours.saturday : hours.weekdays;
    if (!window) continue;
    const date = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
    const start = instantForLocalTime(date, window[0] * 60, timeZone);
    const end = instantForLocalTime(date, window[1] * 60, timeZone);
    if (t.getTime() < start.getTime()) return start;
    if (t.getTime() < end.getTime()) return t;
  }
  return null;
}

export type AiSkipReason = 'skill_off' | 'not_ready' | 'private' | 'opted_out' | 'repeat' | 'limit' | 'no_hours' | 'handled' | 'replied' | 'provider';

/** Pure: whether the AI calls this person back, or the first reason it doesn't. */
export function decideAiCallback(f: {
  skillOn: boolean;
  ready: boolean;
  from: string | null;
  optedOut: boolean;
  calledToday: boolean;
  agentCallsToday: number;
  agencyCallsToday: number;
  limits: { perAgent: number; perAgency: number };
}): 'schedule' | Exclude<AiSkipReason, 'no_hours' | 'handled' | 'replied' | 'provider'> {
  if (!f.skillOn) return 'skill_off';
  if (!f.ready) return 'not_ready';
  if (!f.from || !/^\+61\d{9}$/.test(f.from)) return 'private';
  if (f.optedOut) return 'opted_out';
  if (f.calledToday) return 'repeat';
  if (f.agentCallsToday >= f.limits.perAgent || f.agencyCallsToday >= f.limits.perAgency) return 'limit';
  return 'schedule';
}

export const AI_REASON_WORDS: Record<AiSkipReason, string> = {
  skill_off: 'AI call back is off in Skills',
  not_ready: 'AI calls are not set up for this number yet',
  private: 'a private or overseas number',
  opted_out: 'they replied STOP',
  repeat: 'already called back today',
  limit: 'daily AI call limit reached',
  no_hours: 'no calling hours this week',
  handled: 'the call was handled first',
  replied: 'they replied by text first',
  provider: 'the AI call could not be placed',
};

/** Retell's word for how a call ended → ours. A call that never reached a person is `no_answer`. */
export function aiOutcomeOf(disconnectionReason: string | null): 'done' | 'no_answer' | 'failed' {
  const r = disconnectionReason ?? '';
  if (['dial_no_answer', 'dial_busy', 'voicemail_reached', 'dial_failed'].includes(r)) return 'no_answer';
  if (r.startsWith('error')) return 'failed';
  return 'done';
}

