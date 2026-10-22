import { and, eq, or } from 'drizzle-orm';
import { agency, integrationAccount, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { integrationResource } from '../integrations/accounts';
import { missingScopes, type IntegrationStatus } from '../integrations/providers';
import { plainAddress } from '../integrations/gmail';

/**
 * Who a one-to-one email comes from (ADR 0026 §2), decided per message on
 * the server, in this order:
 *   1. the person's own connected Gmail;
 *   2. else the agency's connected Gmail — an owner or admin only
 *      (`integration:use`; an agent never sends from it, whatever the old
 *      "Members may send from the agency Gmail" switch says);
 *   3. else the platform sender.
 * Expired or missing-permission accounts count as not connected here, and the
 * screens say so. One statement.
 */

export type SenderChoice =
  | { via: 'gmail'; accountId: string; ownerType: 'user' | 'agency'; address: string }
  | {
      via: 'resend';
      /** Why not the person's own Gmail — for the "connect your Gmail" hint. */
      own: IntegrationStatus | 'not_connected';
      /** The agency has a usable Gmail, but the admin switch keeps this person off it. */
      agencyBlocked: boolean;
    };

export async function resolveSender(db: DbOrTx, actor: Actor): Promise<SenderChoice> {
  if (!actor.agencyId) return { via: 'resend', own: 'not_connected', agencyBlocked: false };
  const rows = await db
    .select({
      id: integrationAccount.id,
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
    .where(
      and(
        eq(integrationAccount.provider, 'gmail'),
        eq(integrationAccount.agencyId, actor.agencyId),
        or(
          and(eq(integrationAccount.ownerType, 'user'), eq(integrationAccount.ownerId, actor.userId)),
          and(eq(integrationAccount.ownerType, 'agency'), eq(integrationAccount.ownerId, actor.agencyId)),
        ),
      ),
    );

  const usable = (r: (typeof rows)[number]) => {
    if (r.status !== 'connected' || missingScopes('gmail', r.scopes ?? []).length) return null;
    if (!can(actor, 'integration:use', integrationResource(r))) return null;
    try {
      return plainAddress(r.label ?? '');
    } catch {
      return null; // no address to send From — treated as not connected
    }
  };

  const own = rows.find((r) => r.ownerType === 'user');
  const ownAddress = own ? usable(own) : null;
  if (own && ownAddress) return { via: 'gmail', accountId: own.id, ownerType: 'user', address: ownAddress };

  const shared = rows.find((r) => r.ownerType === 'agency');
  const sharedAddress = shared ? usable(shared) : null;
  let agencyBlocked = false;
  if (shared && sharedAddress) {
    if (can(actor, 'gmail:send_as_agency', { type: 'agency', agencyId: actor.agencyId, membersMayUseAgencyGmail: shared.membersMay })) {
      return { via: 'gmail', accountId: shared.id, ownerType: 'agency', address: sharedAddress };
    }
    agencyBlocked = true;
  }
  const ownState = own ? (own.status === 'connected' && missingScopes('gmail', own.scopes ?? []).length ? 'permission_missing' : own.status) : 'not_connected';
  return { via: 'resend', own: ownState, agencyBlocked };
}

/** The "Sent from" line every screen shows before anything is sent. */
export function senderLine(choice: SenderChoice, platformName = 'LocalAgentHub'): string {
  if (choice.via === 'gmail') {
    return choice.ownerType === 'user' ? `Sent from your Gmail (${choice.address})` : `Sent from the agency’s Gmail (${choice.address})`;
  }
  const hint =
    choice.own === 'expired' ? ' — your Gmail connection expired; reconnect it to send as you'
    : choice.own === 'permission_missing' ? ' — your Gmail is missing the send permission; reconnect it'
    : ' — connect your Gmail to send as you';
  return `Sent from ${platformName}${hint}`;
}

/** The small label on a sent message: how it actually left. */
export function sentViaLabel(m: { sentVia: string | null; senderOwnerType: string | null }, platformName = 'LocalAgentHub'): string {
  if (m.sentVia === 'gmail') return m.senderOwnerType === 'agency' ? 'Sent from the agency’s Gmail' : 'Sent from their Gmail';
  return `Sent from ${platformName}`;
}
