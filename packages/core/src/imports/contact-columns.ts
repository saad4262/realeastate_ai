import { z } from 'zod';
import { CONTACT_ROLES, type ContactRoleKind } from '../contacts/contact-schema';
import { AU_STATES } from '../listings/listing-schema';
import { localInputToInstant } from '../time/local-input';

/**
 * The contacts import's columns (ADR 0029 amendment, "Contacts import") — pure, so the browser's
 * mapping screen can use them too (columns-client.ts). The one place a row's cells become a contact.
 * Marketing consent is never a column: an imported list is not consent.
 */

export const CONTACT_IMPORT_FIELDS = ['name', 'first_name', 'last_name', 'email', 'phone', 'address', 'suburb', 'state', 'postcode', 'roles', 'assigned_email', 'note', 'next_action', 'next_action_date'] as const;
export type ContactImportField = (typeof CONTACT_IMPORT_FIELDS)[number];

export const CONTACT_FIELD_LABELS: Record<ContactImportField, string> = {
  name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  address: 'Street address',
  suburb: 'Suburb',
  state: 'State',
  postcode: 'Postcode',
  roles: 'Roles (buyer, seller…)',
  assigned_email: 'Assigned agent’s email',
  note: 'Note',
  next_action: 'Next action',
  next_action_date: 'Next action date',
};

/** The four details every row must have (ADR 0084). The name is the fourth: full, or first and last, so it is checked as a pair. */
export const CONTACT_REQUIRED_FIELDS: readonly ContactImportField[] = ['email', 'phone', 'address'];

export type ContactImportMapping = Partial<Record<ContactImportField, number | null>>;
export const contactMappingSchema = z.record(z.enum(CONTACT_IMPORT_FIELDS), z.number().int().min(0).max(500).nullable());

const SYNONYMS: Record<string, ContactImportField> = {
  full_name: 'name', contact_name: 'name', contact: 'name',
  first: 'first_name', firstname: 'first_name', given_name: 'first_name',
  last: 'last_name', lastname: 'last_name', surname: 'last_name', family_name: 'last_name',
  email_address: 'email', e_mail: 'email', mail: 'email',
  mobile: 'phone', mobile_phone: 'phone', phone_number: 'phone', mobile_number: 'phone', telephone: 'phone', tel: 'phone',
  street: 'address', street_address: 'address', address_line_1: 'address', address_1: 'address', address1: 'address', home_address: 'address', postal_address: 'address', residential_address: 'address',
  city: 'suburb', town: 'suburb', locality: 'suburb', address_suburb: 'suburb',
  address_state: 'state', region: 'state',
  post_code: 'postcode', postal_code: 'postcode', zip: 'postcode', zip_code: 'postcode', zipcode: 'postcode', pcode: 'postcode',
  role: 'roles', type: 'roles', contact_type: 'roles', tags: 'roles', category: 'roles',
  agent: 'assigned_email', agent_email: 'assigned_email', assigned_to: 'assigned_email', owner: 'assigned_email',
  notes: 'note', comment: 'note', comments: 'note',
  follow_up: 'next_action', followup: 'next_action', next_step: 'next_action',
  follow_up_date: 'next_action_date', due: 'next_action_date', due_date: 'next_action_date',
};

const key = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function contactAutoMap(headers: readonly string[]): ContactImportMapping {
  const out: ContactImportMapping = {};
  headers.forEach((h, i) => {
    const k = key(h);
    const field = (CONTACT_IMPORT_FIELDS as readonly string[]).includes(k) ? (k as ContactImportField) : SYNONYMS[k];
    if (field && out[field] === undefined) out[field] = i;
  });
  for (const f of CONTACT_IMPORT_FIELDS) if (out[f] === undefined) out[f] = null;
  return out;
}

/** Why this mapping cannot be checked yet, or null. */
export function contactMappingProblem(m: ContactImportMapping): string | null {
  const has = (f: ContactImportField) => m[f] !== null && m[f] !== undefined;
  if (!has('name') && !has('first_name') && !has('last_name')) return 'Choose a column for the name (Full name, or First name and Last name)';
  const missing = CONTACT_REQUIRED_FIELDS.filter((f) => !has(f));
  if (missing.length) return `Choose a column for: ${missing.map((f) => CONTACT_FIELD_LABELS[f]).join(', ')}`;
  return null;
}

const ROLE_SYNONYMS: Record<string, ContactRoleKind> = {
  vendor: 'seller',
  purchaser: 'buyer',
  renter: 'tenant',
  lessee: 'tenant',
  lessor: 'landlord',
  owner: 'landlord',
  // ADR 0061: the words a CRM export uses for the three newer roles.
  'past client': 'past_client',
  'past-client': 'past_client',
  'former client': 'past_client',
  'previous client': 'past_client',
  referral: 'referral_partner',
  referrer: 'referral_partner',
  'referral partner': 'referral_partner',
  'referral-partner': 'referral_partner',
  'referral source': 'referral_partner',
  'potential client': 'prospect',
};

/** What a valid row becomes; the import writes exactly this through `createContact`. */
export type NormalizedContact = {
  name: string;
  email: string | null;
  phone: string | null;
  /** ADR 0079: where they live — kept as written, never geocoded. */
  addressLine: string | null;
  addressSuburb: string | null;
  addressState: string | null;
  addressPostcode: string | null;
  roles: ContactRoleKind[];
  assignedEmail: string | null;
  note: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
};

export type CellError = { column: string; message: string };

const STATE_NAMES: Record<string, (typeof AU_STATES)[number]> = {
  'new south wales': 'NSW',
  victoria: 'VIC',
  queensland: 'QLD',
  'western australia': 'WA',
  'south australia': 'SA',
  tasmania: 'TAS',
  'australian capital territory': 'ACT',
  'northern territory': 'NT',
};

/** "nsw", "N.S.W." or "New South Wales" → `NSW`; anything else, null. */
function auState(raw: string): (typeof AU_STATES)[number] | null {
  const short = raw.replace(/[.\s]/g, '').toUpperCase();
  if ((AU_STATES as readonly string[]).includes(short)) return short as (typeof AU_STATES)[number];
  return STATE_NAMES[raw.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

/**
 * Four digits, or null. A spreadsheet stores a Darwin postcode as the number 800 — the leading zero
 * is put back; "2026.0" is a number cell too.
 */
function auPostcode(raw: string): string | null {
  const t = raw.trim().replace(/\.0+$/, '');
  if (/^\d{4}$/.test(t)) return t;
  if (/^\d{3}$/.test(t)) return `0${t}`;
  return null;
}
const EMAIL = z.string().email();

/** Why a row with no address cannot be fixed by a model: there is nothing in the row to take it from. */
export const NO_ADDRESS = 'No address on this row';

const ADDRESS_TAIL = new RegExp(`^(.+),\\s*([^,]+?)[\\s,]+(${[...AU_STATES, ...Object.keys(STATE_NAMES)].join('|')})[\\s,]+(\\d{3,4})(?:[\\s,]+australia)?$`, 'i');

/**
 * An old file's one Address column, "3/12 Campbell Parade, Bondi Beach NSW 2026", into its parts.
 * Null unless the street, suburb, state and postcode can all be told apart; the text then stays as written.
 */
export function splitAuAddress(raw: string): { line: string; suburb: string; state: string; postcode: string } | null {
  const m = ADDRESS_TAIL.exec(raw.trim());
  const state = m ? auState(m[3]!) : null;
  const postcode = m ? auPostcode(m[4]!) : null;
  return m && state && postcode ? { line: m[1]!.trim(), suburb: m[2]!.trim(), state, postcode } : null;
}

/** One row → a contact, or every reason it cannot be one, against its column. */
export function normalizeContactRow(cells: readonly string[], mapping: ContactImportMapping, timeZone: string): { row: NormalizedContact | null; errors: CellError[] } {
  const errors: CellError[] = [];
  const get = (f: ContactImportField) => {
    const i = mapping[f];
    return i === null || i === undefined ? '' : (cells[i] ?? '').trim();
  };
  const err = (f: ContactImportField, message: string) => errors.push({ column: CONTACT_FIELD_LABELS[f], message });

  const name = (get('name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
  if (!name) err(mapping.name !== null && mapping.name !== undefined ? 'name' : 'first_name', 'No name on this row');
  else if (name.length > 120) err('name', 'The name is longer than 120 characters');

  const emailRaw = get('email').toLowerCase();
  const email = emailRaw || null;
  if (email && (email.length > 200 || !EMAIL.safeParse(email).success)) err('email', `“${emailRaw}” does not look like an email address`);
  const phone = get('phone') || null;
  if (phone && phone.length > 40) err('phone', 'The phone number is longer than 40 characters');
  if (!email) err('email', 'No email on this row');
  if (!phone) err('phone', 'No phone on this row');

  const addressCell = get('address').replace(/\s+/g, ' ');
  const joined = addressCell && !get('suburb') && !get('state') && !get('postcode') ? splitAuAddress(addressCell) : null;
  const addressLine = joined?.line ?? (addressCell || null);
  if (!addressLine) err('address', NO_ADDRESS);
  if (addressLine && addressLine.length > 200) err('address', 'The address is longer than 200 characters');
  const addressSuburb = joined?.suburb ?? (get('suburb').replace(/\s+/g, ' ') || null);
  if (addressSuburb && addressSuburb.length > 120) err('suburb', 'The suburb is longer than 120 characters');
  const stateRaw = get('state');
  const addressState = joined ? (joined.state as (typeof AU_STATES)[number]) : stateRaw ? auState(stateRaw) : null;
  if (stateRaw && !addressState) err('state', `“${stateRaw}” is not an Australian state — use ${AU_STATES.join(', ')}`);
  const postcodeRaw = get('postcode');
  const addressPostcode = joined?.postcode ?? (postcodeRaw ? auPostcode(postcodeRaw) : null);
  if (postcodeRaw && !addressPostcode) err('postcode', `“${postcodeRaw}” is not a postcode — four digits, e.g. 2026`);

  const roles: ContactRoleKind[] = [];
  for (const part of get('roles').split(/[,;|/]/).map((r) => r.trim().toLowerCase()).filter(Boolean)) {
    const role = (CONTACT_ROLES as readonly string[]).includes(part) ? (part as ContactRoleKind) : ROLE_SYNONYMS[part] ?? ROLE_SYNONYMS[part.replace(/s$/, '')] ?? ((CONTACT_ROLES as readonly string[]).includes(part.replace(/s$/, '')) ? (part.replace(/s$/, '') as ContactRoleKind) : null);
    if (!role) err('roles', `“${part}” is not a role — use ${CONTACT_ROLES.map((r) => r.replace(/_/g, ' ')).join(', ')}`);
    else if (!roles.includes(role)) roles.push(role);
  }

  const assigned = get('assigned_email').toLowerCase();
  if (assigned && !EMAIL.safeParse(assigned).success) err('assigned_email', `“${assigned}” does not look like an email address`);
  const note = get('note');
  if (note.length > 5000) err('note', 'The note is longer than 5,000 characters');
  const nextAction = get('next_action');
  if (nextAction.length > 300) err('next_action', 'The next action is longer than 300 characters');
  const due = get('next_action_date');
  let nextActionAt: string | null = null;
  if (due) {
    const at = /^\d{4}-\d{2}-\d{2}$/.test(due) ? localInputToInstant(`${due}T09:00`, timeZone) : null;
    if (!at) err('next_action_date', `“${due}” — dates are written YYYY-MM-DD, e.g. 2026-11-14`);
    else nextActionAt = at.toISOString();
  }
  if (errors.length) return { row: null, errors };
  return {
    row: { name, email, phone, addressLine, addressSuburb, addressState, addressPostcode, roles, assignedEmail: assigned || null, note: note || null, nextAction: nextAction || null, nextActionAt },
    errors,
  };
}

