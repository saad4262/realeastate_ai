import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { agency, integrationAccount, integrationChoice, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { integrationResource } from '../integrations/accounts';
import { missingScopes, type IntegrationProvider, type IntegrationStatus } from '../integrations/providers';
import { plainAddress } from '../integrations/gmail';
import { pickActive, PURPOSE_PROVIDERS } from '../integrations/choice';

/**
 * Who a one-to-one email comes from (ADR 0026 §2), decided per message on
 * the server, in this order — "mailbox" being the owner's ACTIVE one, Gmail or
 * Outlook (ADR 0076, `integrations/choice.ts`):
 *   1. the person's own connected mailbox;
 *   2. else the agency's connected mailbox — an owner or admin only
 *      (`integration:use`; an agent never sends from it, whatever the old
 *      "Members may send from the agency Gmail" switch says);
 *   3. else the platform sender.
 * Expired or missing-permission accounts count as not connected here, and the
 * screens say so. One statement.
 */

/** How a message leaves through a connected mailbox: `sent_via` and the label's word. */
export type MailboxVia = 'gmail' | 'outlook';
export const MAILBOX_VIA: Record<'gmail' | 'outlook_mail', MailboxVia> = { gmail: 'gmail', outlook_mail: 'outlook' };
export const MAILBOX_NAME: Record<MailboxVia, string> = { gmail: 'Gmail', outlook: 'Outlook' };

export type SenderChoice =
  | { via: MailboxVia; accountId: string; ownerType: 'user' | 'agency'; address: string }
  | {
      via: 'resend';
      /** Why not the person's own mailbox — for the "connect your Gmail or Outlook" hint. */
      own: IntegrationStatus | 'not_connected';
      /** Which of theirs that is about (their active one), when they have one. */
      ownVia?: MailboxVia;
      /** The agency has a usable Gmail, but the admin switch keeps this person off it. */
      agencyBlocked: boolean;
    };

export async function resolveSender(db: DbOrTx, actor: Actor): Promise<SenderChoice> {
  if (!actor.agencyId) return { via: 'resend', own: 'not_connected', agencyBlocked: false };
  const rows = await db
    .select({
      id: integrationAccount.id,
      provider: integrationAccount.provider,
      chosen: integrationChoice.provider,
      agencyId: integrationAccount.agencyId,
      ownerType: integrationAccount.ownerType,
      ownerId: integrationAccount.ownerId,
      status: integrationAccount.status,
      scopes: integrationAccount.grantedScopes,
      label: integrationAccount.externalAccountLabel,
      membersMay: agency.membersMayUseAgencyGmail,
    })
    .from(integrationAccount)
    .innerJoin(agency, eq(agency.id, integrationAccount.agencyId))
    // ADR 0076: the owner's choice between Gmail and Outlook, in the same statement.
    .leftJoin(
      integrationChoice,
      and(
        eq(integrationChoice.agencyId, integrationAccount.agencyId),
        eq(integrationChoice.ownerType, integrationAccount.ownerType),
        eq(integrationChoice.ownerId, integrationAccount.ownerId),
        sql`${integrationChoice.purpose} = 'mail'`,
      ),
    )
    .where(
      and(
        inArray(integrationAccount.provider, [...PURPOSE_PROVIDERS.mail]),
        eq(integrationAccount.agencyId, actor.agencyId),
        or(
          and(eq(integrationAccount.ownerType, 'user'), eq(integrationAccount.ownerId, actor.userId)),
          and(eq(integrationAccount.ownerType, 'agency'), eq(integrationAccount.ownerId, actor.agencyId)),
        ),
      ),
    );

  const usable = (r: (typeof rows)[number]) => {
    if (r.status !== 'connected' || missingScopes(r.provider, r.scopes ?? []).length) return null;
    if (!can(actor, 'integration:use', integrationResource(r))) return null;
    try {
      return plainAddress(r.label ?? '');
    } catch {
      return null; // no address to send From — treated as not connected
    }
  };

  // Each owner's ACTIVE mailbox (never the other one when the active one is expired: fail closed).
  const activeOf = (ownerType: 'user' | 'agency') => {
    const mine = rows.filter((r) => r.ownerType === ownerType).map((r) => ({ ...r, provider: r.provider as IntegrationProvider }));
    return pickActive(mine, (mine[0]?.chosen as IntegrationProvider | null) ?? null, 'mail');
  };
  const viaOf = (r: { provider: IntegrationProvider }) => MAILBOX_VIA[r.provider as 'gmail' | 'outlook_mail'];

  const own = activeOf('user');
  const ownAddress = own ? usable(own) : null;
  if (own && ownAddress) return { via: viaOf(own), accountId: own.id, ownerType: 'user', address: ownAddress };

  const shared = activeOf('agency');
  const sharedAddress = shared ? usable(shared) : null;
  let agencyBlocked = false;
  if (shared && sharedAddress) {
    if (can(actor, 'gmail:send_as_agency', { type: 'agency', agencyId: actor.agencyId, membersMayUseAgencyGmail: shared.membersMay })) {
      return { via: viaOf(shared), accountId: shared.id, ownerType: 'agency', address: sharedAddress };
    }
    agencyBlocked = true;
  }
  const ownState = own ? (own.status === 'connected' && missingScopes(own.provider, own.scopes ?? []).length ? 'permission_missing' : own.status) : 'not_connected';
  return { via: 'resend', own: ownState, ...(own ? { ownVia: viaOf(own) } : {}), agencyBlocked };
}

/** The "Sent from" line every screen shows before anything is sent. */
export function senderLine(choice: SenderChoice, platformName = 'LocalAgentHub'): string {
  if (choice.via !== 'resend') {
    const name = MAILBOX_NAME[choice.via];
    return choice.ownerType === 'user' ? `Sent from your ${name} (${choice.address})` : `Sent from the agency’s ${name} (${choice.address})`;
  }
  const mine = choice.ownVia ? MAILBOX_NAME[choice.ownVia] : 'Gmail or Outlook';
  const hint =
    choice.own === 'expired' ? ` — your ${mine} connection expired; reconnect it to send as you`
    : choice.own === 'permission_missing' ? ` — your ${mine} is missing the send permission; reconnect it`
    : ' — connect your Gmail or Outlook to send as you';
  return `Sent from ${platformName}${hint}`;
}

/** The small label on a sent message: how it actually left. */
export function sentViaLabel(m: { sentVia: string | null; senderOwnerType: string | null }, platformName = 'LocalAgentHub'): string {
  if (m.sentVia === 'gmail' || m.sentVia === 'outlook') {
    const name = MAILBOX_NAME[m.sentVia];
    return m.senderOwnerType === 'agency' ? `Sent from the agency’s ${name}` : `Sent from their ${name}`;
  }
  return `Sent from ${platformName}`;
}
