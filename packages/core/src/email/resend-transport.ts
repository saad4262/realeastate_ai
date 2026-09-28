import { EmailError, type EmailMessage, type EmailTransport, type SendResult } from './transport';

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
}): EmailTransport {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async send(message: EmailMessage): Promise<SendResult> {
      const body = {
        from: formatAddress(message.from),
        to: [formatAddress(message.to)],
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: {
          /**
           * RFC 8058. The `-Post` header is what makes Gmail and Outlook show
           * their own one-click unsubscribe control, which is both the best
           * unsubscribe experience and a large deliverability signal. Sending
           * the first without the second gets the link ignored.
           */
          'List-Unsubscribe': `<${message.listUnsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        ...(message.tags
          ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }
          : {}),
      };

      let response: Response;
      try {
        response = await doFetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          // A hung provider must not hold a cron tick open until the platform
          // kills the whole function and every remaining schedule with it.
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        // A network failure or a timeout is worth trying again; a rejected
        // address is not, and this is the former.
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Network error',
          retryable: true,
        };
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
    },
  };
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
