/**
 * How mail leaves this system.
 *
 * A port, in the shape `AuthProvisioner` established in
 * ../team/invite-agent.ts: core owns the decision about what to send and to
 * whom, and the thing that actually sends is handed in. That is what lets
 * every test in `pnpm test` exercise the real digest-building code with no
 * network and no key — which matters more here than usual, because the
 * failure mode of getting this wrong is mail going to a real person.
 */
export type EmailAddress = {
  email: string;
  name?: string;
};

type EmailBase = {
  to: EmailAddress;
  from: EmailAddress;
  subject: string;
  html: string;
  /**
   * Always present, never optional, on both kinds.
   *
   * A text/plain part is a deliverability requirement — a multipart message
   * without one scores as spam — and it is the version a plain-text client
   * and some screen readers will actually get. The Spam Act's sender
   * identification has to appear in both, or it appears in neither.
   */
  text: string;
  /** Correlation only. Never a person's details — these reach the provider's logs. */
  tags?: Record<string, string>;
};

/**
 * Bulk mail somebody asked to receive and can stop receiving.
 *
 * The saved-search digest, and for now only that. The unsubscribe URL is
 * required by the type because s.18 of the Spam Act requires it in fact, and
 * because a digest built without one would otherwise be a runtime surprise.
 */
export type MarketingMessage = EmailBase & {
  kind: 'marketing';
  /** RFC 8058 one-click, and the Spam Act's functional unsubscribe in header form. */
  listUnsubscribeUrl: string;
};

/**
 * A one-off notification to somebody about something that just happened to
 * them — a private offer arriving in an agency's inbox.
 *
 * It carries NO unsubscribe header, and `?: never` rather than `?: string` so
 * that setting one is a compile error rather than a quiet mistake. Two reasons,
 * and the second is the load-bearing one:
 *
 * 1. It is doubtful this is a "commercial electronic message" under s.6 at all.
 *    It does not advertise or promote the sender's goods or services; it tells a
 *    business that an offer has been made TO it. s.18's unsubscribe requirement
 *    attaches to commercial electronic messages, so there is nothing here to
 *    relax away — the old shape simply over-applied s.18 to a category it does
 *    not cover, which is why it fought every transactional message.
 *
 * 2. `resendTransport` pairs `List-Unsubscribe` with
 *    `List-Unsubscribe-Post: One-Click`, which is a promise that the URL accepts
 *    an unauthenticated POST and acts on it. Mailbox providers, link scanners
 *    and prefetchers all take that promise up. Inventing an unsubscribe target
 *    for an agency's offer notifications would ship a one-click way to silently
 *    switch them off, and a lost offer is worse than any deliverability gain.
 *
 * s.17 sender identification is NOT relaxed: it is cheap, it is correct on any
 * business mail, and `requireSenderFooter` enforces it on both kinds.
 */
export type TransactionalMessage = EmailBase & {
  kind: 'transactional';
  listUnsubscribeUrl?: never;
};

/**
 * `kind` has no default and no optional marker, so a new builder cannot omit
 * it. "Transactional" is always a word somebody typed and a reviewer reads in
 * the diff, never an omission.
 */
export type EmailMessage = MarketingMessage | TransactionalMessage;

export type SendResult =
  | { ok: true; id: string }
  /**
   * `retryable` separates "the provider is busy" (429, 5xx) from "this
   * address is wrong" (422). Retrying the second one forever is how a
   * sending reputation dies.
   */
  | { ok: false; error: string; retryable: boolean };

export type EmailTransport = {
  send(message: EmailMessage): Promise<SendResult>;
};

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailError';
  }
}

export type FakeTransport = EmailTransport & {
  readonly sent: readonly EmailMessage[];
};

/**
 * The transport every unit test uses.
 *
 * There is deliberately no way to get a live one in `pnpm test`:
 * `@repo/config/test-offline` makes `fetch` throw on any http(s) URL, so a
 * test that reached for `resendTransport` would fail loudly rather than
 * quietly send. A key in `.env.local` is not consent to spend it, and it is
 * even less consent to email somebody.
 */
export function fakeTransport(opts: { fail?: { error: string; retryable: boolean } } = {}): FakeTransport {
  const sent: EmailMessage[] = [];

  return {
    sent,
    async send(message: EmailMessage): Promise<SendResult> {
      if (opts.fail) {
        return { ok: false, error: opts.fail.error, retryable: opts.fail.retryable };
      }
      sent.push(message);
      return { ok: true, id: `fake-${sent.length}` };
    },
  };
}

/**
 * A transport that accepts everything and sends nothing.
 *
 * For `ALERTS_DRY_RUN=1` on a preview deployment, where the whole pipeline
 * should run and be inspectable without a single real message going out.
 */
export function dryRunTransport(): EmailTransport {
  return {
    async send(): Promise<SendResult> {
      return { ok: true, id: 'dry-run' };
    },
  };
}
