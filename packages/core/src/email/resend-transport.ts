import { randomUUID } from 'node:crypto';
import { mailConfigFromEnv, type MailConfig } from '../mail/address';
import { dryRunTransport, EmailError, type EmailMessage, type EmailTransport, type SendResult } from './transport';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function formatAddress(address: { email: string; name?: string }): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

/**
 * Resend, over plain `fetch`.
 *
 * Deliberately not the `resend` npm package. This is one POST with a JSON
 * body; a dependency that can validate, retry or serialise differently from
 * what the test asserts is a dependency that can break sending without this
 * file changing. Same reasoning as ../media/storage-client.ts, which talks to
 * Supabase Storage the same way and for the same reason.
 *
 * `fetchImpl` is injectable so a unit test can assert the REQUEST BODY rather
 * than the configuration. ARCHITECTURE § 12 records why that distinction
 * matters: a model swap broke /chat completely while 99 unit tests stayed
 * green, because nothing built a request and looked at it.
 */
export function resendTransport(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** PLATFORM-PLAN 3.5: the waits before each retry of a busy or unreachable Resend. Tests pass zeros. */
  retryDelaysMs?: readonly number[];
}): EmailTransport {
  const doFetch = opts.fetchImpl ?? fetch;
  const delays = opts.retryDelaysMs ?? [500, 2000];
  // After one email used up its retries, the rest fail fast for a while: a tick sending fifty emails into an
  // outage must not spend 2.5 s on each and run past its time.
  let downUntil = 0;

  /**
   * PLATFORM-PLAN 3.5, one place for every email the platform sends: a 429, a 5xx or a dropped connection is
   * tried again, twice, under the same Idempotency-Key, so Resend sends it once however many attempts reach
   * it. A timeout is not tried again here: it already took 15 s of a tick's budget, and the caller's own
   * record (failed, retried by its tick or shown to the person) takes it from there. Once an email has used up
   * its retries, the next 30 s of sends from this transport try once each.
   * shortcut: retries within the one call only; a Resend outage longer than ~3 s still fails the send, so
   * callers without their own retry lose that email — move them onto the job queue (3.1) if that is seen.
   */
  async function send(message: EmailMessage): Promise<SendResult> {
    const withKey = message.idempotencyKey ? message : { ...message, idempotencyKey: randomUUID() };
    const tries = Date.now() < downUntil ? 0 : delays.length;
    for (let attempt = 0; ; attempt++) {
      const r = await sendOnce(withKey);
      if (r.ok || !r.retryable || 'timedOut' in r || attempt >= tries) {
        if (!r.ok && r.retryable && tries > 0) downUntil = Date.now() + 30_000;
        return r.ok ? r : { ok: false, error: r.error, retryable: r.retryable };
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }

  return { send };

  async function sendOnce(message: EmailMessage): Promise<SendResult | { ok: false; error: string; retryable: true; timedOut: true }> {
    const threadingHeaders = message.threading
      ? {
          'In-Reply-To': message.threading.inReplyTo,
          References: message.threading.references.join(' '),
        }
      : null;

    const body = {
      from: formatAddress(message.from),
      to: [formatAddress(message.to)],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo ? { reply_to: [formatAddress(message.replyTo)] } : {}),
      // Threading headers never meet the unsubscribe pair: a marketing
      // message is never a reply, so at most one of these two spreads applies.
      ...(threadingHeaders && message.kind === 'transactional' ? { headers: threadingHeaders } : {}),
      /**
       * RFC 8058, on marketing mail only.
       *
       * The `-Post` header is what makes Gmail and Outlook show their own
       * one-click unsubscribe control, which is both the best unsubscribe
       * experience and a large deliverability signal. Sending the first
       * without the second gets the link ignored — so both go together or
       * neither does, which is why this is one spread and not two.
       *
       * Transactional mail sends neither. `-Post` promises the URL accepts an
       * unauthenticated POST, and there is no such URL for a notification
       * nobody subscribed to. See TransactionalMessage.
       */
      ...(message.kind === 'marketing'
        ? {
            headers: {
              'List-Unsubscribe': `<${message.listUnsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
        : {}),
      ...(message.tags
        ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }
        : {}),
      // Resend: base64 `content`, with the type given rather than guessed from the name.
      ...(message.attachments?.length
        ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.contentBase64, content_type: a.contentType })) }
        : {}),
    };

    let response: Response;
    try {
      response = await doFetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          // Resend keeps a key 24 hours: the same key and body are sent once (ADR 0039 Phase 1).
          ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        // A hung provider must not hold a cron tick open until the platform
        // kills the whole function and every remaining schedule with it.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A network failure or a timeout is worth trying again; a rejected
      // address is not, and this is the former.
      const error = err instanceof Error ? err.message : 'Network error';
      if (err instanceof Error && err.name === 'TimeoutError') return { ok: false, error, retryable: true, timedOut: true };
      return { ok: false, error, retryable: true };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Resend ${response.status}: ${detail.slice(0, 300)}`,
        // 429 and 5xx are the provider's problem. 4xx is ours, and repeating
        // it just tells them we are not listening.
        retryable: response.status === 429 || response.status >= 500,
      };
    }

    const payload = (await response.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: payload.id ?? 'unknown' };
  }
}

export type SenderIdentity = {
  from: { email: string; name: string };
  /** Printed in the footer of every message. Spam Act s.17. */
  postalAddress: string;
};

/**
 * The sender, or a refusal.
 *
 * Read at the point of use rather than at module load, so a missing value is
 * a skipped send on one run and never a boot failure — the rule
 * `requireAnthropicKey` in @repo/config sets out.
 *
 * It throws rather than defaulting because there is no safe default. An
 * alert email with no sender identity and no postal address is not a
 * degraded email, it is one the Spam Act does not permit sending.
 */
export function requireSenderIdentity(env: NodeJS.ProcessEnv = process.env): SenderIdentity {
  const email = env.ALERT_EMAIL_FROM?.trim();
  const name = env.ALERT_SENDER_NAME?.trim();
  const postalAddress = env.ALERT_SENDER_ADDRESS?.trim();

  if (!email || !name || !postalAddress) {
    const missing = [
      !email && 'ALERT_EMAIL_FROM',
      !name && 'ALERT_SENDER_NAME',
      !postalAddress && 'ALERT_SENDER_ADDRESS',
    ].filter(Boolean);
    throw new EmailError(`Alert email is not configured: ${missing.join(', ')} not set`);
  }

  /**
   * Present is not the same as usable.
   *
   * `ALERT_EMAIL_FROM` was set to `quotemydecking.com.au` — the domain, with
   * no mailbox — for two days. This function checked only that it was
   * non-empty, so it passed; the value went out as
   * `Test Company <quotemydecking.com.au>` and Resend refused every send
   * with a validation error. The failure was recorded on each run, which is
   * the design working, but nobody reads a run row until somebody complains
   * that no email arrived.
   *
   * A shape check, not an RFC 5322 parser: the addresses this ever holds are
   * typed by whoever deploys, and the mistake to catch is a missing `@` or a
   * name accidentally wrapped in. Anything stricter would start rejecting
   * valid addresses to catch faults nobody has made.
   */
  if (!/^[^\s@<>,]+@[^\s@<>,.]+\.[^\s@<>,]+$/.test(email)) {
    throw new EmailError(
      `Alert email is not configured: ALERT_EMAIL_FROM is "${email}", which is not an email address. ` +
        'It needs a mailbox as well as a domain — alerts@example.com, not example.com.',
    );
  }

  return { from: { email, name }, postalAddress };
}

/** The transport the scheduler should use, given the environment it is in. */
export function requireResendTransport(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new EmailError('Alert email is not configured: RESEND_API_KEY not set');
  return resendTransport({ apiKey });
}

/**
 * Sender and transport together, for a notice sent from a request.
 *
 * `ALERTS_DRY_RUN=1` builds everything and sends nothing — the switch the
 * digest and the offer notice already honour, so one setting quiets all mail
 * from an environment. Throws (EmailError) when mail is not configured; the
 * callers treat that as "not sent", never as a failed request.
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): {
  sender: SenderIdentity;
  transport: EmailTransport;
} {
  const sender = requireSenderIdentity(env);
  const transport = env.ALERTS_DRY_RUN === '1' ? dryRunTransport() : requireResendTransport(env);
  return { sender, transport };
}

/**
 * Everything a notice sent from a request needs: the mailer, and the origins
 * of the two console hosts its links point at. Both apps send notices (the web
 * app on a new enquiry, the console on an invite or an assignment), so this is
 * here rather than written twice.
 *
 * Null when mail is not configured: the caller carries on without sending and
 * says so, rather than failing the write it follows.
 */
export function noticeMailFromEnv(env: NodeJS.ProcessEnv = process.env): {
  mailer: { sender: SenderIdentity; transport: EmailTransport };
  urls: { agentUrl: string; agencyUrl: string; webUrl: string };
  /** Inbound mail, when set up (ADR 0016) — notices then reply into the conversation. */
  config: MailConfig | null;
} | null {
  let mailer: ReturnType<typeof mailerFromEnv>;
  try {
    mailer = mailerFromEnv(env);
  } catch (err) {
    console.warn('[mail] not configured:', (err as Error).message);
    return null;
  }
  return {
    mailer,
    urls: {
      agentUrl: env.NEXT_PUBLIC_AGENT_URL?.trim() || 'http://agents.lvh.me:3001',
      agencyUrl: env.NEXT_PUBLIC_AGENCY_URL?.trim() || 'http://agency.lvh.me:3001',
      webUrl: env.NEXT_PUBLIC_WEB_URL?.trim() || 'http://web.lvh.me:3000',
    },
    config: mailConfigFromEnv(env),
  };
}
