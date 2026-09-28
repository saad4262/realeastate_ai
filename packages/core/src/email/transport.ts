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

export type EmailMessage = {
  to: EmailAddress;
  from: EmailAddress;
  subject: string;
  html: string;
  /**
   * Always present, never optional.
   *
   * A text/plain part is a deliverability requirement — a multipart message
   * without one scores as spam — and it is the version a plain-text client
   * and some screen readers will actually get. The Spam Act's sender
   * identification has to appear in both, or it appears in neither.
   */
  text: string;
  /** RFC 8058 one-click, and the Spam Act's functional unsubscribe in header form. */
  listUnsubscribeUrl: string;
  /** Correlation only. Never a person's details — these reach the provider's logs. */
  tags?: Record<string, string>;
};

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
