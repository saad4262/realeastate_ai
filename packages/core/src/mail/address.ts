import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The addresses mail comes back to. See docs/adr/0016.
 *
 * Three kinds, all on MAIL_INBOUND_DOMAIN (the third from ADR 0035):
 *  - `m+<teamThreadId>.<sig>@domain` — the Reply-To on a team message's email:
 *    a colleague answering it from their mail. Signed over a different string
 *    from a conversation's, so one can never be turned into the other.
 *  - `t+<threadId>.<sig>@domain` — the Reply-To on everything a conversation
 *    sends. Signed, because a thread id alone would let anybody who learned one
 *    write into somebody else's conversation from any address.
 *  - `<agency-slug>@domain` — the agency's own address. Mail to it with no
 *    thread opens a new conversation that only admins see.
 *
 * Derived rather than stored, the same reasoning as the unsubscribe token:
 * nothing to generate, migrate or drift.
 */

export type MailConfig = {
  /** Lower-cased, no leading `@`. */
  inboundDomain: string;
  replySecret: string;
};

/**
 * Both values, or none.
 *
 * Half a configuration is treated as none — a domain with no secret cannot sign,
 * and a secret with no domain has nowhere to receive — and it says which half
 * is missing, because "replies are not threading" is otherwise a silent bug.
 */
export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const domain = env.MAIL_INBOUND_DOMAIN?.trim().replace(/^@/, '').toLowerCase();
  const secret = env.MAIL_REPLY_SECRET?.trim();
  if (!domain && !secret) return null;
  if (!domain || !secret) {
    console.warn(
      `[mail] inbound is off: ${!domain ? 'MAIL_INBOUND_DOMAIN' : 'MAIL_REPLY_SECRET'} is not set`,
    );
    return null;
  }
  return { inboundDomain: domain, replySecret: secret };
}

/** Lower-case hex, so a mail system that folds the local part's case cannot break it. */
function signature(threadId: string, secret: string): string {
  // 80 bits. The token cannot be tried offline — every guess is an email we
  // receive — so this is far past what guessing could reach.
  return createHmac('sha256', secret).update(`thread:${threadId}`).digest('hex').slice(0, 20);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function teamSignature(threadId: string, secret: string): string {
  return createHmac('sha256', secret).update(`team:${threadId}`).digest('hex').slice(0, 20);
}

export function teamReplyAddress(threadId: string, config: MailConfig): string {
  return `m+${threadId.toLowerCase()}.${teamSignature(threadId.toLowerCase(), config.replySecret)}@${config.inboundDomain}`;
}

const TEAM_RE = new RegExp(`^m\\+(${UUID})\\.([0-9a-f]{20})@(.+)$`);

/** The team conversation a reply address names, or null when it is not one of ours or the signature is wrong. */
export function parseTeamReplyAddress(address: string, config: MailConfig): string | null {
  const match = TEAM_RE.exec(bareAddress(address));
  if (!match) return null;
  const [, threadId, offered, domain] = match as unknown as [string, string, string, string];
  if (domain !== config.inboundDomain) return null;
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(teamSignature(threadId, config.replySecret), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return threadId;
}

export function threadReplyAddress(threadId: string, config: MailConfig): string {
  return `t+${threadId.toLowerCase()}.${signature(threadId.toLowerCase(), config.replySecret)}@${config.inboundDomain}`;
}

const REPLY_RE = new RegExp(`^t\\+(${UUID})\\.([0-9a-f]{20})@(.+)$`);

/** The thread a reply address names, or null when it is not one of ours or the signature is wrong. */
export function parseThreadReplyAddress(address: string, config: MailConfig): string | null {
  const match = REPLY_RE.exec(bareAddress(address));
  if (!match) return null;
  const [, threadId, offered, domain] = match as unknown as [string, string, string, string];
  if (domain !== config.inboundDomain) return null;

  const expected = signature(threadId, config.replySecret);
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Same length by the regex, checked anyway: timingSafeEqual throws otherwise.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return threadId;
}

export function agencyMailAddress(slug: string, config: MailConfig): string {
  return `${slug.toLowerCase()}@${config.inboundDomain}`;
}

/** The agency slug an address names, or null. A reply address is never an agency's. */
export function parseAgencyMailAddress(address: string, config: MailConfig): string | null {
  const bare = bareAddress(address);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return null;
  const local = bare.slice(0, at);
  if (bare.slice(at + 1) !== config.inboundDomain) return null;
  if (local.startsWith('t+')) return null;
  return /^[a-z0-9][a-z0-9-]*$/.test(local) ? local : null;
}

/**
 * `Sara Khan <sara@example.com>` → `sara@example.com`, lower-cased.
 *
 * Every comparison of addresses in this module goes through here. The domain
 * part is case-insensitive by RFC; the local part technically is not, but no
 * provider anyone uses treats it so, and a buyer who typed `Bea@` on the form
 * and replies from `bea@` is the same person.
 */
export function bareAddress(value: string): string {
  const angled = /<([^<>]+)>\s*$/.exec(value);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}

/** The display name in `Name <addr>`, or null. */
export function displayName(value: string): string | null {
  const match = /^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/.exec(value);
  const name = match?.[1]?.trim();
  return name ? name : null;
}
