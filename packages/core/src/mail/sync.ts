import { inArray } from 'drizzle-orm';
import { mailMessage, teamMessage, type Db } from '@repo/db';
import { noticeMailFromEnv } from '../email/resend-transport';
import { verifySecretFromEnv } from './verify-email';
import { mailConfigFromEnv, type MailConfig } from './address';
import { notifyThreadReply } from './notices';
import { deliverTeamMessage } from '../team-messages/messages';
import { deliverOutbound } from './send';
import { fetchReceivedEmail, ingestReceivedEmail, routeRecipients, type IngestOutcome } from './inbound';
import type { MailDeps } from './send';

/**
 * Pulling received mail from Resend, instead of waiting for it to be pushed.
 *
 * The webhook (`/api/mail/inbound`) needs a public URL Resend can reach, which
 * a laptop on localhost does not have and a deployment only has once DNS and
 * the webhook are set up. This asks Resend "what have you received?" — the
 * List Received Emails API — so replies reach the inbox anywhere the app runs.
 * Both paths end in the same `ingestReceivedEmail`, and `provider_id` is unique,
 * so an email the webhook already stored is skipped here and vice versa.
 *
 * ## Cheap on purpose
 *
 * The list carries `to`/`cc`, which is all routing needs. A full email is
 * fetched only when it is addressed to one of OUR addresses and is not already
 * stored — so mail to other addresses on the domain costs nothing but the list
 * call, and a quiet inbox costs one request per sync.
 *
 * Network calls happen here, outside any transaction; each ingest opens its own.
 */

const RESEND_RECEIVING = 'https://api.resend.com/emails/receiving';

type ListItem = { id: string; to?: string[] | null; cc?: string[] | null; created_at?: string };
type ListPage = { data?: ListItem[]; has_more?: boolean };

export type SyncResult = {
  /** Received emails Resend listed. */
  listed: number;
  /** New ones that were addressed to us and stored. */
  outcomes: IngestOutcome[];
};

/** How far back a sync looks. Older mail was either synced already or is not coming. */
const LOOKBACK_DAYS = 14;
const PAGE_SIZE = 100;

export async function syncReceivedEmails(
  db: Db,
  deps: MailDeps & { config: MailConfig },
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; maxPages?: number; now?: Date } = {},
): Promise<SyncResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const oldest = (opts.now ?? new Date()).getTime() - LOOKBACK_DAYS * 86_400_000;
  const maxPages = opts.maxPages ?? 3;

  const candidates: string[] = [];
  let listed = 0;
  let after: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const url = `${RESEND_RECEIVING}?limit=${PAGE_SIZE}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Resend ${response.status} listing received emails`);
    const body = (await response.json()) as ListPage;
    const items = body.data ?? [];
    listed += items.length;

    let tooOld = false;
    for (const item of items) {
      if (item.created_at && Date.parse(item.created_at) < oldest) {
        tooOld = true;
        continue;
      }
      // Routing from the list alone: a full fetch only for mail that is ours.
      if (routeRecipients([...(item.to ?? []), ...(item.cc ?? [])], deps.config)) candidates.push(item.id);
    }

    const last = items.at(-1);
    if (!body.has_more || !last || tooOld) break;
    after = last.id;
  }

  if (candidates.length === 0) return { listed, outcomes: [] };

  // Already stored (by the webhook, or an earlier sync): one statement for all.
  const seen = await db
    .select({ id: mailMessage.providerId })
    .from(mailMessage)
    .where(inArray(mailMessage.providerId, candidates));
  const seenTeam = await db
    .select({ id: teamMessage.providerId })
    .from(teamMessage)
    .where(inArray(teamMessage.providerId, candidates));
  const known = new Set([...seen, ...seenTeam].map((s) => s.id));

  const outcomes: IngestOutcome[] = [];
  // Oldest first, so a thread's messages are stored in the order they arrived.
  for (const id of candidates.filter((c) => !known.has(c)).reverse()) {
    const email = await fetchReceivedEmail(id, apiKey, doFetch);
    outcomes.push(await ingestReceivedEmail(db, deps, email));
  }
  return { listed, outcomes };
}

/**
 * One sync, configured from the environment, with its sends handed back.
 *
 * What the console's inbox, the buyer's messages page and the cron tick all
 * call. It never throws: a sync that cannot run (inbound not configured, Resend
 * down) is reported, and the screen that asked still renders.
 *
 * `followUp` is the relays and notices the new mail calls for — run it after
 * the response (`after()`), the same rule as every other send.
 */
export type PullResult =
  | { ok: true; stored: number; followUp: (() => Promise<void>) | null }
  | { ok: false; reason: 'not_configured' | 'failed'; followUp: null };

export async function pullReceivedMail(opts: {
  db: () => Db;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<PullResult> {
  const env = opts.env ?? process.env;
  const config = mailConfigFromEnv(env);
  const notice = noticeMailFromEnv(env);
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!config || !notice || !apiKey) return { ok: false, reason: 'not_configured', followUp: null };

  const deps = {
    mailer: notice.mailer,
    config,
    site: { webUrl: notice.urls.webUrl, verifySecret: verifySecretFromEnv(env) },
  };
  try {
    const db = opts.db();
    const { outcomes } = await syncReceivedEmails(db, deps, apiKey, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const stored = outcomes.filter((o) => o.kind === 'stored' || o.kind === 'relay' || o.kind === 'team');
    const followUp = stored.length
      ? async () => {
          for (const o of stored) {
            try {
              if (o.kind === 'relay') await deliverOutbound(db, deps, o.messageId);
              else if (o.kind === 'team') await deliverTeamMessage(db, { mailer: deps.mailer, config, urls: notice.urls }, o.messageId);
              else if (o.kind === 'stored' && o.notify) {
                await notifyThreadReply(db, { ...deps, urls: notice.urls }, o.threadId, o.messageId);
              }
            } catch (err) {
              console.error('[mail] sync follow-up failed', err instanceof Error ? err.message : err);
            }
          }
        }
      : null;
    return { ok: true, stored: stored.length, followUp };
  } catch (err) {
    console.error('[mail] sync failed:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'failed', followUp: null };
  }
}
