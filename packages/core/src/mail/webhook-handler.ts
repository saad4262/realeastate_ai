import type { Db } from '@repo/db';
import { noticeMailFromEnv } from '../email/resend-transport';
import { verifySecretFromEnv } from './verify-email';
import { mailConfigFromEnv } from './address';
import { fetchReceivedEmail, ingestReceivedEmail, type IngestOutcome } from './inbound';
import { receivedEventSchema } from './mail-schema';
import { notifyThreadReply } from './notices';
import { deliverTeamMessage } from '../team-messages/messages';
import { deliverOutbound } from './send';
import { verifyResendWebhook, type WebhookHeaders } from './webhook';

/**
 * POST /api/mail/inbound, minus the framework (docs/adr/0016).
 *
 * In packages/core rather than the route for the reason cron-guard.ts gives:
 * `pnpm test` runs core, so a guard written in a route handler is a guard with
 * no test.
 *
 * ## Status codes are instructions to Resend
 *
 * Resend retries anything that is not 2xx. So:
 *  - 401: not signed by Resend. Retrying cannot fix it.
 *  - 200: handled, or deliberately ignored (another event type, inbound
 *    switched off, mail we do not route). Retrying would change nothing.
 *  - 503: WE could not do it right now — the body fetch or the database
 *    failed. A retry is exactly what is wanted, and a duplicate delivery is
 *    harmless because `provider_id` is unique.
 *
 * The database is a thunk so an unsigned request is refused before a
 * connection is ever opened.
 */

export type InboundResponse = {
  status: 200 | 400 | 401 | 503;
  body: { ok: boolean; outcome?: IngestOutcome['kind'] | 'ignored'; error?: string };
  /** Sends to run after the response (relay, notices). Never inside the write. */
  followUp: (() => Promise<void>) | null;
};

export async function handleInboundWebhook(opts: {
  db: () => Db;
  rawBody: string;
  headers: WebhookHeaders;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}): Promise<InboundResponse> {
  const env = opts.env ?? process.env;

  if (
    !verifyResendWebhook({
      headers: opts.headers,
      body: opts.rawBody,
      secret: env.RESEND_WEBHOOK_SECRET,
      ...(opts.nowSeconds !== undefined ? { nowSeconds: opts.nowSeconds } : {}),
    })
  ) {
    return { status: 401, body: { ok: false, error: 'unauthorised' }, followUp: null };
  }

  let event: ReturnType<typeof receivedEventSchema.parse>;
  try {
    event = receivedEventSchema.parse(JSON.parse(opts.rawBody));
  } catch {
    return { status: 400, body: { ok: false, error: 'not an event' }, followUp: null };
  }
  if (event.type !== 'email.received') {
    return { status: 200, body: { ok: true, outcome: 'ignored' }, followUp: null };
  }

  const config = mailConfigFromEnv(env);
  if (!config) return { status: 200, body: { ok: true, outcome: 'ignored' }, followUp: null };

  const notice = noticeMailFromEnv(env);
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!notice || !apiKey) {
    return { status: 503, body: { ok: false, error: 'mail is not configured' }, followUp: null };
  }
  const deps = {
    mailer: notice.mailer,
    config,
    site: { webUrl: notice.urls.webUrl, verifySecret: verifySecretFromEnv(env) },
  };

  try {
    // The network call, before any write (CLAUDE.md).
    const email = await fetchReceivedEmail(event.data.email_id, apiKey, opts.fetchImpl);
    const db = opts.db();
    const outcome = await ingestReceivedEmail(db, deps, email);

    let followUp: InboundResponse['followUp'] = null;
    if (outcome.kind === 'relay') {
      followUp = async () => {
        await deliverOutbound(db, deps, outcome.messageId);
      };
    } else if (outcome.kind === 'team') {
      followUp = async () => {
        await deliverTeamMessage(db, { mailer: deps.mailer, config, urls: notice.urls }, outcome.messageId);
      };
    } else if (outcome.kind === 'stored' && outcome.notify) {
      followUp = async () => {
        await notifyThreadReply(db, { ...deps, urls: notice.urls }, outcome.threadId, outcome.messageId);
      };
    }
    return { status: 200, body: { ok: true, outcome: outcome.kind }, followUp };
  } catch (err) {
    // The email id only — never an address or a subject; this reaches logs.
    console.error(`[mail] inbound ${event.data.email_id} failed:`, err instanceof Error ? err.message : err);
    return { status: 503, body: { ok: false, error: 'try again' }, followUp: null };
  }
}
