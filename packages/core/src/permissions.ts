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
  /**
   * Acting for a workflow (ADR 0041): set by the engine on the owner's actor when a workflow's step
   * runs. Never a permission — can() ignores it — only so the change it makes does not trigger
   * workflows in turn (no loops, v1).
   *
   * `platform` (ADR 0049): a READ-ONLY view of an agency, or of one member of it, opened by a
   * platform admin from the admin console. Unlike `workflow` this one IS a permission: can()
   * refuses every action outside PLATFORM_READ before any other rule is asked, so no write
   * function in core can run under it. Only `platformViewActor` builds one.
   */
  via?: 'workflow' | 'platform';
  /** On a `platform` view: the admin actually looking (for the view log). */
  viewerId?: string;
  /**
   * A platform admin (ADR 0049) — a row in `platform_admin`, set only by `loadPlatformAdmin`.
   * Grants `platform:read` and nothing else: it is not a membership, so every agency rule
   * still refuses it. Reading an agency's data goes through a `platform` view actor.
   */
  platformAdmin?: boolean;
};

export type Action =
  | 'listing:read'
  /**
   * Every listing in the agency as ROWS in a figure or a list (ADR 0036 P1).
   * Owner/admin. Without it, `listingScopeFilters` narrows to the listings the
   * actor is named on. `listing:read` still opens any one listing of the agency.
   */
  | 'listing:read_all'
  | 'listing:create'
  | 'listing:edit'
  /**
   * Put a listing on the public site. Owner/admin only (ADR 0014): an agent's
   * ad reaches the public after somebody who runs the agency has seen it.
   */
  | 'listing:publish'
  /**
   * Ask for that: draft or withdrawn → `pending`. Whoever may edit the listing
   * — an admin, or an agent named on it.
   */
  | 'listing:submit'
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
   * Every lead in the agency, unscoped. Owner/admin. Anybody else's inbox is
   * narrowed in SQL to the leads `lead:read` would let them open one by one.
   */
  | 'lead:read_all'
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
   * is what lets them say they have done it. While nobody is assigned, an agent
   * named on the listing it came through (`listingId`) may move it — the buyer
   * asked them. Once assigned to someone else it is theirs alone, which keeps
   * two people from "handling" one enquiry and each assuming the other did.
   *
   * On an offer the caller must ALSO pass `lead:read_offer`: you cannot triage
   * a row you are not allowed to see.
   */
  /**
   * Record a lead by hand (ADR 0040): any member who may write, on a listing
   * their figures cover (`listingScopeFilters` — an agent's own listings, an
   * admin's agency) — checked in SQL by `createManualLead`. It is theirs.
   */
  | 'lead:create'
  | 'lead:update'
  /**
   * Give a lead to a member, or take it back.
   *
   * Admins only. Deciding who works which enquiry is running the agency, the
   * same line `listing:delete` and `team:manage` draw.
   */
  | 'lead:assign'
  /**
   * Open one email conversation (ADR 0016). The resource is the thread, with
   * its lead's assignee as `ownerId` and its lead's listing as `listingId` —
   * the same rule as `lead:read`, because a lead's conversation IS the lead.
   * A thread with no lead (mail to the agency's own address) carries neither,
   * so only an admin may open it. An offer's thread must also pass
   * `lead:read_offer`, exactly as the lead itself does.
   */
  | 'mail:read'
  /**
   * Reply on a conversation: `lead:update`'s rule. Writing to a buyer in the
   * agency's name is working the lead; whoever may move it along may answer it.
   */
  | 'mail:send'
  /**
   * A buyer reading their own conversations on the website. `ownerId` is the
   * account the thread was matched to; no agency role reaches this.
   */
  | 'mail:read_own'
  /**
   * Write a NEW email to a contact (ADR 0035 §1): `contact:update`'s rule —
   * the contact's assignee or an owner/admin, never a read-only member. The
   * same person who may answer that contact's mail to the agency address.
   */
  | 'mail:compose'
  /**
   * A team conversation (ADR 0035 §3). With an id: only the people on it
   * (`participantIds`) — not admins. Without one: the Team messages page,
   * any active member.
   */
  | 'team_message:read'
  /** Start one, or write on one you are on. Read-only members read only. */
  | 'team_message:send'
  /**
   * A buyer seeing their own meetings on the website (ADR 0032 §5): the ones
   * an agency sent them an invitation for, at an address they proved.
   * `ownerId` is their account; no agency role reaches this.
   */
  | 'meeting:read_own'
  /**
   * See a contact (ADR 0018). The resource carries the contact's assignee as
   * `ownerId`, the members assigned its non-offer leads as `leadAssigneeIds`,
   * and the members named on the listings it is tied to (its non-offer leads'
   * listings, and this agency's listings at properties linked to it) as
   * `listingAgentIds`. Admins see every contact; anybody else a contact that
   * is theirs, or that they meet through a lead they could already open. No
   * id: "open the directory", which any active member may.
   *
   * Seeing a contact is not seeing all of it: inside a profile each lead and
   * email still answers to `lead:read` / `mail:read`, and offers stay
   * `lead:read_offer`. A contact visible only through an offer is not visible.
   */
  | 'contact:read'
  /** Every contact in the agency, unnarrowed. Owner/admin. */
  | 'contact:read_all'
  /** Add a contact by hand. Any active member who is not read-only. */
  | 'contact:create'
  /**
   * Change a contact's details, roles, consent, next action. An admin, or the
   * member it is ASSIGNED to (`ownerId`). Somebody who sees a contact only
   * through a lead may add notes, not edit it. Read-only members never edit.
   */
  | 'contact:update'
  /**
   * Archive or restore a contact: hide it from the directory without deleting
   * anything. Same rule as `contact:update` — it is that person's call about
   * their own book, or an admin's.
   */
  | 'contact:archive'
  /** Give a contact to a member, or take it back. Admins, as with leads. */
  | 'contact:assign'
  /** Fold one contact into another. Admins: it changes who can see whom. */
  | 'contact:merge'
  /** Write a note on a contact: whoever may see it, unless read-only. */
  | 'note:create'
  /** Edit or delete a note: its author (`ownerId`), or an admin. */
  | 'note:manage'
  /**
   * Read a note marked private: the agency's admins, and its author
   * (`ownerId`). No id: "every private note in the agency" — admins only, and
   * that is how a list decides whether to filter at all.
   */
  | 'note:read_private'
  /**
   * Attach a document to a contact (ADR 0053 §3): `note:create`'s rule — whoever may see the
   * contact, unless read-only. The resource is the CONTACT.
   */
  | 'document:upload'
  /** Attach a document to a listing's property: `listing:edit`'s rule. The resource is the LISTING. */
  | 'document:upload_listing'
  /** Delete a document: its uploader (`ownerId`), or an admin — `note:manage`'s shape. */
  | 'document:delete'
  /**
   * Read a document marked private, or one on no contact and no listing (an attachment to the
   * agency's own address): admins and its uploader (`ownerId`). The list says it in SQL
   * (`documentScopeFilters`); this is the same rule for one row.
   */
  | 'document:read_private'
  /** Read the agency's knowledge base (ADR 0053): every member, read-only ones included. */
  | 'knowledge:read'
  /** Add to or remove from the knowledge base: owners and admins — it is the agency's voice. */
  | 'knowledge:manage'
  /** See an opportunity the platform found (ADR 0054): only the member it was found for (`ownerId`). */
  | 'opportunity:read'
  /** Mark it done or dismiss it: the same person. */
  | 'opportunity:update'
  /**
   * See one appointment (ADR 0019). Admins see the agency's whole calendar; any
   * other member sees appointments assigned to them (`ownerId`) or that they
   * booked (`createdBy`) — never another agent's, even with the same contact.
   * A team meeting (ADR 0038) also to the colleagues on it (`participantIds`).
   * No id: "open my calendar", which any active member may.
   */
  | 'appointment:read'
  /** The agency's whole calendar, unnarrowed. Owner/admin. */
  | 'appointment:read_all'
  /** Book one. Any active member who is not read-only — and who may see the contact. */
  | 'appointment:create'
  /**
   * Complete, cancel, reschedule, edit, send its invitation: the agent it is
   * assigned to (`ownerId`), or an admin. Read-only members never.
   */
  | 'appointment:update'
  /** Book one for somebody else, or hand it over. Admins, as with leads and contacts. */
  | 'appointment:assign'
  /**
   * Decline a team meeting you are on (ADR 0038 §3): only a participant, for
   * themselves — the host and admins change it with `appointment:update`.
   */
  | 'appointment:respond'
  /**
   * See a connected account's STATUS (ADR 0020) — never its tokens. Your own
   * user-level accounts; your agency's agency-level ones only as an owner or
   * admin (ADR 0020 amendment, 2026-10-22: everyone else works through their
   * own accounts only). The resource carries `integrationOwnerType` and
   * `ownerId` (a user id, or the agency id). No id with no owner type: "open my
   * integrations page", any active member.
   */
  | 'integration:read'
  /**
   * Connect or disconnect. Your own user-level account (not read-only
   * members); an agency-level one only owner/admin.
   */
  | 'integration:manage'
  /**
   * Let the SERVER use the tokens on your behalf (create your calendar event,
   * your Zoom meeting). Never a way to read them: no function returns a token
   * outside packages/core. Your own user-level account; an agency-level one
   * only for an owner or admin — never a fallback for an agent.
   */
  | 'integration:use'
  /**
   * Browse the skill library (ADR 0021): the platform's skills (no agency on
   * the resource) and your own agency's. Any active member.
   */
  | 'skill:read'
  /** Add, edit or archive your agency's own library skills. Owner/admin. */
  | 'skill:curate'
  /**
   * Your own copy of a skill (`ownerId` = its agent): read it and its runs.
   * Nobody else's — not even an admin's, as with saved searches: a brief is
   * one person's working view.
   */
  | 'agent_skill:read'
  /** Add to your list, edit, schedule, switch on/off, run now. Not read-only members. */
  | 'agent_skill:manage'
  /** See the agency's email templates (ADR 0022). Any active member. */
  | 'email_template:read'
  /**
   * Write a template (ready when saved — ADR 0043, no approval): anyone who may
   * write creates one; only its author (`ownerId`) or an admin edits or retires it.
   */
  | 'email_template:draft'
  /**
   * Owner/admin (ADR 0043): their templates are for the whole agency, and they
   * see, edit and retire every template in it.
   */
  | 'email_template:manage'
  /** Prepare a bulk send. Any active member who is not read-only. */
  | 'email_batch:create'
  /** See a batch: the agent who prepared it (`ownerId`), or an admin. */
  | 'email_batch:read'
  /** Approve & Send, retry failed: only the agent who prepared it. */
  | 'email_batch:send'
  /** Cancel a prepared batch: its agent or an admin. */
  | 'email_batch:cancel'
  /** Save and use your own directory filters. */
  | 'contact_filter:manage'
  /**
   * Open the console assistant (ADR 0025). Any active member — read-only
   * members too, because Phase A's tools only read, and each tool still asks
   * can() and the SQL scope filters as this person.
   */
  | 'assistant:use'
  /**
   * Read or continue an assistant conversation (`ownerId` = its author). Its
   * author only — not even an admin (ADR 0025 Q5): admins see actions and
   * their audit, never the chat text.
   */
  | 'assistant_conversation:read'
  /**
   * See an action the assistant proposed (`ownerId` = the person it acted
   * for): its author, or an admin — admins see actions and their audit, not
   * the chat (ADR 0025 Q5).
   */
  | 'proposed_action:read'
  /** Approve or reject it: its author only, never read-only (ADR 0025 §7). */
  | 'proposed_action:decide'
  /**
   * See one console notification, or mark it read (ADR 0032 §4): only the
   * person it is for (`ownerId`), in the agency it belongs to. Not admins — a
   * reminder is personal, and the meeting itself is already on their calendar.
   * Read-only members see their own reminders too.
   */
  | 'notification:read'
  | 'notification:update'
  /** Cancel one not yet run: its author or an admin. */
  | 'proposed_action:cancel'
  /** Save a dashboard (ADR 0027, decided Q4): owners and admins only. */
  | 'dashboard:create'
  /**
   * Open a dashboard: same agency, signed in, and its `audience` —
   * `private` its creator, `admins` any owner/admin, `agency` any active member.
   * Every figure on it is then computed as the viewer.
   */
  | 'dashboard:read'
  /** Rename, change audience, archive: its creator or an admin. */
  | 'dashboard:manage'
  /** Agency-wide money and performance figures (Sold value, sales). Owner/admin. */
  | 'report:read_agency'
  /**
   * Ask an open question of the agency's data (ADR 0042): the assistant writes a
   * read-only query over the named datasets, each scoped as this person. Any
   * member who may write; a read-only member may not.
   */
  | 'report:query'
  /**
   * Start a CSV listing import (ADR 0029): any member who may write. An
   * agent's import is forced to `pending` (admin approval); only someone with
   * `listing:publish` may import live or as draft.
   */
  | 'listing_import:create'
  /** Import contacts from a file or a sheet (ADR 0029 amendment): whoever may add contacts. */
  | 'contact_import:create'
  /**
   * Workflows (ADR 0041 D2). See one and its runs: its owner, or an owner/admin (every workflow of the
   * agency). Make one that acts on the maker's own leads and contacts: any member who may write. Make an
   * agency-wide one (which may assign): owners/admins. Pause, resume, archive: its owner or an admin.
   */
  | 'workflow:read'
  | 'workflow:create'
  | 'workflow:create_agency'
  | 'workflow:manage'
  /** See an import and its row report: its creator, or an admin. */
  | 'listing_import:read'
  /** Map, dry-run and run it: its creator only. */
  | 'listing_import:run'
  /** Cancel it: its creator or an admin. */
  | 'listing_import:cancel'
  /**
   * Send a one-to-one email from the AGENCY's connected Gmail (ADR 0026):
   * owners/admins always; other writing members unless an admin has switched
   * "Members may send from the agency Gmail" off. On top of `integration:use`.
   */
  | 'gmail:send_as_agency'
  /** Flip that switch: owner/admin. */
  | 'gmail:configure_agency'
  /** Pick or change the agency's Google listing (ADR 0028): owner/admin. */
  | 'google_place:manage'
  /** See the agency's Google rating and reviews in the console: any active member. */
  | 'review:read'
  | 'team:manage'
  /** Remove (or restore) another OWNER (ADR 0030): owners only. Never yourself, never the last owner — checked in core. */
  | 'team:remove_owner'
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
  | 'chat:write'
  /** The admin console (ADR 0049): list every agency and open a read-only view of one. */
  | 'platform:read'
  /**
   * The admin console's controls (ADR 0050): suspend or reactivate an agency, its plan and trial,
   * block or unblock a member, change the owner. Every platform admin, for now (no admin roles yet).
   */
  | 'platform:manage';

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
  /**
   * The listing a lead came through, when the resource is one lead. An agent
   * named on that listing may read the lead even while nobody is assigned —
   * it is their campaign's buyer.
   */
  listingId?: string | null;
  /** On a contact: members assigned one of its non-offer leads. */
  leadAssigneeIds?: string[];
  /** On a contact: members named on a listing it is tied to. See `contact:read`. */
  listingAgentIds?: string[];
  /** On an appointment: who booked it. */
  createdBy?: string | null;
  /** On an integration account: a person's (`user`) or the agency's. */
  integrationOwnerType?: 'user' | 'agency';
  /** On a dashboard: who may open it. */
  audience?: 'private' | 'admins' | 'agency';
  /** On the agency, for `gmail:send_as_agency`: the admin switch (ADR 0026, decided Q3). */
  membersMayUseAgencyGmail?: boolean;
  /** On a team conversation (ADR 0035 §3), or a team meeting's colleagues besides its host (ADR 0038). */
  participantIds?: string[];
};

const ADMIN_ROLES: MembershipRole[] = ['owner', 'admin'];

/**
 * Roles that look and never touch (the user's rule for contacts, 2026-10-05):
 * a read-only member sees what an agent would, and writes nothing — not even a
 * note.
 */
const VIEW_ONLY_ROLES: MembershipRole[] = ['read_only'];

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

function mayWrite(actor: Actor): boolean {
  return Boolean(actor.membershipRole && !VIEW_ONLY_ROLES.includes(actor.membershipRole));
}

function isListingAgent(actor: Actor, listingId?: string): boolean {
  if (!listingId || !actor.listingAgentOf) return false;
  return actor.listingAgentOf.includes(listingId);
}

/**
 * What a `platform` view actor may still do (ADR 0049): look. Every other action is refused
 * before its own rule runs, whatever role the view carries — the view of an owner cannot send,
 * assign, approve or delete anything. A new action is NOT in here until someone decides it is a
 * read; the permission test lists every action and fails if a write slips in.
 *
 * The rule each of these then runs is the ordinary one for the role the view carries: the
 * agency-wide view is an owner's and sees what an owner sees; an agent's view sees what that
 * agent sees, their own team conversations and assistant chats included.
 */
export const PLATFORM_READ: ReadonlySet<Action> = new Set<Action>([
  'listing:read',
  'listing:read_all',
  'lead:read',
  'lead:read_all',
  'lead:read_offer',
  'mail:read',
  'mail:read_own',
  'team_message:read',
  'meeting:read_own',
  'contact:read',
  'contact:read_all',
  'note:read_private',
  'appointment:read',
  'appointment:read_all',
  'integration:read',
  'skill:read',
  'agent_skill:read',
  'email_template:read',
  'email_batch:read',
  'assistant_conversation:read',
  'proposed_action:read',
  'dashboard:read',
  'report:read_agency',
  'workflow:read',
  'listing_import:read',
  'review:read',
]);

export function can(actor: Actor, action: Action, resource: Resource): boolean {
  if (actor.via === 'platform' && !PLATFORM_READ.has(action)) return false;
  switch (action) {
    case 'listing:read':
      // The agency's own listings only — drafts, pending and withdrawn ones
      // included, so never another agency's. Was `|| Boolean(membershipRole)`
      // for `type: 'listing'`, i.e. any member of ANY agency; every caller
      // happened to pass its own agency id, so nothing leaked, but the first
      // caller to pass the listing's real agency would have opened other
      // agencies' drafts (found by the ADR 0030 matrix). Public listings are
      // read through the public search, which never asks this.
      return sameAgency(actor, resource) && Boolean(actor.membershipRole);

    case 'listing:create':
      // Any active member of the agency who may write may draft a listing;
      // publishing it is a separate decision, and every new listing starts as
      // a draft. Not a read-only member: they look and never touch (the rule of
      // 2026-10-05) — `Boolean(membershipRole)` let them draft one (found with
      // the assistant's listing tools, ADR 0040 part 2 §4).
      return sameAgency(actor, resource) && mayWrite(actor);

    case 'listing:edit':
    case 'listing:submit':
    // Grouped with edit because the rule is the same, not because the
    // decision is. See the Action union for why it is its own member.
    case 'listing:sell':
      if (!sameAgency(actor, resource)) return false;
      if (isAgencyAdmin(actor)) return true;
      return isListingAgent(actor, resource.id);

    case 'listing:publish':
      // ADR 0014: the approval step. Being named on the listing is enough to
      // write it and to submit it, not to put it in front of the public.
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'lead:read':
    // One rule, grouped on purpose: a lead's conversation is the lead (ADR 0016).
    case 'mail:read': {
      // Any active membership opens an inbox. `sameAgency` stops it crossing
      // tenancy.
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      // Asked about the inbox as a whole (no lead id): yes — what is IN it is
      // narrowed by `lead:read_all` below.
      if (!resource.id || isAgencyAdmin(actor)) return true;
      // One lead (ADR 0014): theirs if it is assigned to them, or if it came
      // through a listing they are named on, assigned to anyone or no one.
      if (actor.userId === resource.ownerId) return true;
      return isListingAgent(actor, resource.listingId ?? undefined);
    }

    case 'lead:read_all':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'lead:read_offer':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'lead:update':
    case 'mail:send':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (isAgencyAdmin(actor)) return true;
      if (resource.ownerId) return Boolean(actor.userId) && actor.userId === resource.ownerId;
      // Unassigned: the agent whose listing it came through may work it — they
      // are the one the buyer asked. Once assigned, it is the assignee's.
      return isListingAgent(actor, resource.listingId ?? undefined);

    case 'lead:assign':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'listing:delete':
      // Deliberately narrower than edit. A deleted listing takes its enquiries,
      // inspections and media with it, and an agent who has left the campaign
      // should not be able to erase the agency's record of it. Being named on
      // the listing is enough to change it; it is not enough to remove it.
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'contact:read': {
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (!resource.id || isAgencyAdmin(actor)) return true;
      if (resource.ownerId && actor.userId === resource.ownerId) return true;
      if (resource.leadAssigneeIds?.includes(actor.userId)) return true;
      return Boolean(resource.listingAgentIds?.includes(actor.userId));
    }

    case 'listing:read_all':
    case 'contact:read_all':
    case 'contact:assign':
    case 'contact:merge':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'contact:create':
    case 'lead:create':
    // Importing contacts is adding them, many at once: the same rule, asked again for each row.
    case 'contact_import:create':
      return sameAgency(actor, resource) && mayWrite(actor);

    case 'contact:update':
    case 'contact:archive':
    // The same rule with a different owner: the contact's assignee there, the
    // note's author here. Grouped because the shape is one decision.
    case 'note:manage':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'note:create':
    // A document on a contact is a note with a file (ADR 0053 §3): the same people.
    case 'document:upload':
      return mayWrite(actor) && can(actor, 'contact:read', resource);

    case 'document:upload_listing':
      return mayWrite(actor) && can(actor, 'listing:edit', resource);

    case 'document:delete':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'document:read_private':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'knowledge:read':
      return sameAgency(actor, resource) && Boolean(actor.membershipRole);

    case 'knowledge:manage':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'opportunity:read':
    case 'opportunity:update':
      // Personal, like the bell: found for one person, about their own work. An admin does not
      // read someone else's — the work itself is theirs to see through the contact and the inbox.
      return sameAgency(actor, resource) && Boolean(actor.membershipRole) &&
        Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'mail:compose':
      return can(actor, 'contact:update', resource);

    case 'team_message:read':
    case 'team_message:send': {
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (action === 'team_message:send' && !mayWrite(actor)) return false;
      // The page as a whole, or starting a new one.
      if (!resource.id) return true;
      // Deliberately NOT `|| isAgencyAdmin(actor)`: a conversation between two
      // people is theirs, as an assistant conversation is its author's.
      return Boolean(resource.participantIds?.includes(actor.userId));
    }

    case 'note:read_private':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'appointment:read': {
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (!resource.id || isAgencyAdmin(actor)) return true;
      if (resource.ownerId && actor.userId === resource.ownerId) return true;
      if (resource.participantIds?.includes(actor.userId)) return true;
      return Boolean(resource.createdBy) && actor.userId === resource.createdBy;
    }

    case 'appointment:read_all':
    case 'appointment:assign':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'appointment:respond':
      if (!sameAgency(actor, resource) || !actor.membershipRole || !resource.id) return false;
      return Boolean(resource.participantIds?.includes(actor.userId));

    case 'appointment:create':
      return sameAgency(actor, resource) && mayWrite(actor);

    case 'appointment:update':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'integration:read':
    case 'integration:use':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (!resource.integrationOwnerType) return action === 'integration:read' && !resource.id;
      if (resource.integrationOwnerType === 'agency') return resource.ownerId === actor.agencyId && isAgencyAdmin(actor);
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'integration:manage':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      if (resource.integrationOwnerType === 'agency') {
        return resource.ownerId === actor.agencyId && isAgencyAdmin(actor);
      }
      if (resource.integrationOwnerType === 'user') {
        return Boolean(resource.ownerId) && actor.userId === resource.ownerId;
      }
      return false;

    case 'skill:read':
      // A platform skill has no agency; any member may read it. An agency's own,
      // only that agency's members.
      if (!actor.agencyId || !actor.membershipRole) return false;
      return !resource.agencyId || sameAgency(actor, resource);

    case 'skill:curate':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'agent_skill:read':
      return sameAgency(actor, resource) && Boolean(actor.membershipRole) &&
        Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'agent_skill:manage':
      return sameAgency(actor, resource) && mayWrite(actor) &&
        Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'workflow:read':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      return isAgencyAdmin(actor) || (Boolean(resource.ownerId) && actor.userId === resource.ownerId);
    case 'workflow:create':
      return sameAgency(actor, resource) && mayWrite(actor);
    case 'workflow:create_agency':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);
    case 'workflow:manage':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      return isAgencyAdmin(actor) || (Boolean(resource.ownerId) && actor.userId === resource.ownerId);

    case 'assistant:use':
      return sameAgency(actor, resource) && Boolean(actor.membershipRole);

    case 'assistant_conversation:read':
      return sameAgency(actor, resource) && Boolean(actor.membershipRole) &&
        Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'dashboard:create':
    case 'report:read_agency':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'report:query':
    case 'listing_import:create':
      return sameAgency(actor, resource) && mayWrite(actor);

    case 'listing_import:read':
    case 'listing_import:cancel':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (action === 'listing_import:cancel' && !mayWrite(actor)) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'gmail:send_as_agency':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      return isAgencyAdmin(actor) || resource.membersMayUseAgencyGmail !== false;

    case 'gmail:configure_agency':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'google_place:manage':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'review:read':
      return sameAgency(actor, resource) && Boolean(actor.membershipRole);

    case 'listing_import:run':
      return sameAgency(actor, resource) && mayWrite(actor) && Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'dashboard:read':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (resource.audience === 'agency') return true;
      if (resource.audience === 'admins') return isAgencyAdmin(actor);
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'dashboard:manage':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'proposed_action:read':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'notification:read':
    case 'notification:update':
      return sameAgency(actor, resource) && Boolean(actor.membershipRole) &&
        Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'proposed_action:decide':
      return sameAgency(actor, resource) && mayWrite(actor) &&
        Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'proposed_action:cancel':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'email_template:read':
      return sameAgency(actor, resource) && Boolean(actor.membershipRole);

    case 'email_template:draft':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      if (!resource.id || isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'email_template:manage':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'email_batch:create':
      return sameAgency(actor, resource) && mayWrite(actor);

    case 'email_batch:read':
      if (!sameAgency(actor, resource) || !actor.membershipRole) return false;
      if (!resource.id || isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'email_batch:send':
      return sameAgency(actor, resource) && mayWrite(actor) &&
        Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'email_batch:cancel':
      if (!sameAgency(actor, resource) || !mayWrite(actor)) return false;
      if (isAgencyAdmin(actor)) return true;
      return Boolean(resource.ownerId) && actor.userId === resource.ownerId;

    case 'contact_filter:manage':
      return sameAgency(actor, resource) && mayWrite(actor) &&
        (!resource.ownerId || actor.userId === resource.ownerId);

    case 'team:remove_owner':
      return sameAgency(actor, resource) && actor.membershipRole === 'owner';

    case 'team:manage':
    case 'agency:billing':
      return sameAgency(actor, resource) && isAgencyAdmin(actor);

    case 'console:agency':
      // Surface gate: actor's own agency membership must be owner|admin
      return Boolean(actor.agencyId) && isAgencyAdmin(actor);

    case 'console:agent':
      return Boolean(actor.agencyId && actor.membershipRole);

    case 'platform:read':
    case 'platform:manage':
      // The admin themself, never a view they opened (a view is already inside one agency).
      return actor.platformAdmin === true && actor.via === undefined;

    case 'schedule:create':
      // Ownership, not membership. An agency owner gets this because they are
      // a signed-in person, not because of their role — to this action a
      // consumer account and an agent's account are the same kind of thing.
      return Boolean(actor.userId);

    case 'mail:read_own':
    case 'meeting:read_own':
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
