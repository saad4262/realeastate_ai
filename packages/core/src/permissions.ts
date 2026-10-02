/**
 * Central authorization. Never check roles in apps/ or UI —
 * always call can(actor, action, resource).
 */
export type MembershipRole =
  | 'owner'
  | 'admin'
  | 'agent'
  | 'assistant'
  | 'property_manager'
  | 'read_only';

export type Actor = {
  userId: string;
  agencyId?: string;
  membershipRole?: MembershipRole;
  /** Listing IDs where actor appears in listing_agent */
  listingAgentOf?: string[];
};

export type Action =
  | 'listing:read'
  | 'listing:create'
  | 'listing:edit'
  | 'listing:publish'
  /**
   * Record a sale: the status, the price it went for, the date.
   *
   * Same rule as publish today, and separate from it on purpose. A published ad
   * can be withdrawn; a sale price becomes a permanent line in the public
   * history of an address, and `UNDELETABLE` then refuses to delete the listing
   * carrying it. Tightening one should not mean tightening the other.
   */
  | 'listing:sell'
  /** Remove a listing outright. Narrower than edit — admins only. */
  | 'listing:delete'
  /**
   * Open the agency's lead inbox at all.
   *
   * Any active member. An enquiry is ordinary business: somebody asked about a
   * listing and whoever is working that campaign has to answer it, so gating
   * this on admin would leave the agent desk with an inbox it cannot open.
   */
  | 'lead:read'
  /**
   * Read a PRIVATE OFFER specifically. Narrower, and separate on purpose.
   *
   * An offer is a named person's financial intent about somebody's home, with
   * their contact details attached, on a property the agency no longer markets.
   * It is the most commercially sensitive row this system holds, and
   * `agencyNotificationRecipients` already decided who hears about one: the
   * owners and admins who run the agency, not everyone who has a login there.
   * This is the same decision, asked on the way in rather than on the way out —
   * and it is a separate ACTION rather than a role check inside the query,
   * because non-negotiable #2 says the decision lives here or nowhere.
   */
  | 'lead:read_offer'
  /**
   * Move a lead through triage: new → contacted → qualified → closed, or back.
   *
   * An agency admin, or the member the lead is ASSIGNED to — passed as the
   * resource's `ownerId`. Assignment is what makes a lead somebody's job, so it
   * is what lets them say they have done it. Anyone else in the agency can read
   * the lead and not move it, which keeps two people from "handling" the same
   * enquiry and each assuming the other did.
   *
   * On an offer the caller must ALSO pass `lead:read_offer`: you cannot triage
   * a row you are not allowed to see.
   */
  | 'lead:update'
  /**
   * Give a lead to a member, or take it back.
   *
   * Admins only. Deciding who works which enquiry is running the agency, the
   * same line `listing:delete` and `team:manage` draw.
   */
  | 'lead:assign'
  | 'team:manage'
  | 'agency:billing'
  /** Agency OS host — owner|admin only */
  | 'console:agency'
  /** Agent desk host — any active membership */
  | 'console:agent'
  /** Save a scheduled search. Any signed-in account; no agency required. */
  | 'schedule:create'
  /** Read a schedule and its runs — /alerts, the chat card, the run detail. */
  | 'schedule:read'
  /** Pause, resume, rename, retime, delete. */
  | 'schedule:manage'
  /** Read one's own saved conversations. */
  | 'chat:read'
  /** Append to, or delete, one's own saved conversations. */
  | 'chat:write';

export type Resource = {
  type: 'listing' | 'lead' | 'team' | 'agency' | 'console' | 'schedule' | 'chat' | string;
  id?: string;
  agencyId?: string;
  /**
   * Whose thing this is, for resources a person owns rather than an agency
   * does.
   *
   * A consumer has no agency, so `sameAgency` can never be the question for
   * one of their resources. This is the second axis the model needed and the
   * reason a consumer did not have to be given a fake membership — see
   * docs/adr/0011.
   */
  ownerId?: string;
};

const ADMIN_ROLES: MembershipRole[] = ['owner', 'admin'];

/**
 * Does this role run the agency rather than sell for it?
 * Display code asks this instead of comparing role strings itself.
 */
export function isAgencyAdminRole(role: MembershipRole | null | undefined): boolean {
  return Boolean(role && ADMIN_ROLES.includes(role));
}

const ROLE_PHRASES: Record<MembershipRole, string> = {
  owner: 'the owner',
  admin: 'an admin',
  agent: 'an agent',
  assistant: 'an assistant',
  property_manager: 'a property manager',
  read_only: 'a read-only member',
};

/**
 * Human phrase for a role, for message copy only — "you are already the owner".
 * Never a permission decision; those stay in can().
 */
export function membershipRolePhrase(role: MembershipRole | null | undefined): string {
  return (role && ROLE_PHRASES[role]) || 'a member';
}

function sameAgency(actor: Actor, resource: Resource): boolean {
  return Boolean(actor.agencyId && resource.agencyId && actor.agencyId === resource.agencyId);
}

function isAgencyAdmin(actor: Actor): boolean {
  return Boolean(actor.membershipRole && ADMIN_ROLES.includes(actor.membershipRole));
}

function isListingAgent(actor: Actor, listingId?: string): boolean {
  if (!listingId || !actor.listingAgentOf) return false;
  return actor.listingAgentOf.includes(listingId);
}

export function can(actor: Actor, action: Action, resource: Resource): boolean {
  switch (action) {
    case 'listing:read':
      if (resource.type === 'listing') {
        return sameAgency(actor, resource) || Boolean(actor.membershipRole);
      }
      return sameAgency(actor, resource);

    case 'listing:create':
      // Any active member of the agency may draft a listing; publishing it is
      // a separate decision, and every new listing starts as a draft.
      return sameAgency(actor, resource) && Boolean(actor.membershipRole);

    case 'listing:edit':
    case 'listing:publish':
    // Grouped with publish because the rule is the same, not because the
    // decision is. See the Action union for why it is its own member.
    case 'listing:sell':
      if (!sameAgency(actor, resource)) return false;
      if (isAgencyAdmin(actor)) return true;
      return isListingAgent(actor, resource.id);

    case 'lead:read':
      // Any active membership. `sameAgency` is what stops it crossing tenancy.
      return sameAgency(actor, resource) && Boolean(actor.membershipRole);

    case 'lead:read_offer':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'lead:update':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(actor.userId) && actor.userId === resource.ownerId;

    case 'lead:assign':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'listing:delete':
      // Deliberately narrower than edit. A deleted listing takes its enquiries,
      // inspections and media with it, and an agent who has left the campaign
      // should not be able to erase the agency's record of it. Being named on
      // the listing is enough to change it; it is not enough to remove it.
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'team:manage':
    case 'agency:billing':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'console:agency':
      // Surface gate: actor's own agency membership must be owner|admin
      return Boolean(actor.agencyId) && isAgencyAdmin(actor);

    case 'console:agent':
      return Boolean(actor.agencyId && actor.membershipRole);

    case 'schedule:create':
      // Ownership, not membership. An agency owner gets this because they are
      // a signed-in person, not because of their role — to this action a
      // consumer account and an agent's account are the same kind of thing.
      return Boolean(actor.userId);

    case 'chat:read':
    case 'chat:write':
    case 'schedule:read':
    case 'schedule:manage':
      // Deliberately NOT `|| isAgencyAdmin(actor)`. An agency admin has no
      // claim on a buyer's saved search or their conversation with the guide:
      // between them those record where somebody wants to live, what they can
      // spend and what they asked in their own words. Being the largest
      // account on the platform is not a reason to read any of it. This is the
      // one place in this file where admin power stops at the tenancy line
      // rather than crossing it.
      return Boolean(actor.userId) && actor.userId === resource.ownerId;

    default: {
      /**
       * Exhaustiveness, the same forcing function `getModel` has.
       *
       * This used to be `return false`, which meant a new Action compiled
       * cleanly and silently denied everything — the failure would have shown
       * up as a button that does nothing, with the permission test as the only
       * thing standing between that and production. Adding an action is now a
       * compile error until it has a rule.
       */
      const never: never = action;
      throw new Error(`No rule for action: ${String(never)}`);
    }
  }
}
