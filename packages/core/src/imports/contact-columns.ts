import { z } from 'zod';
import { CONTACT_ROLES, type ContactRoleKind } from '../contacts/contact-schema';
import { localInputToInstant } from '../time/local-input';

/**
 * The contacts import's columns (ADR 0029 amendment, "Contacts import") — pure, so the browser's
 * mapping screen can use them too (columns-client.ts). The one place a row's cells become a contact.
 * Marketing consent is never a column: an imported list is not consent.
 */

export const CONTACT_IMPORT_FIELDS = ['name', 'first_name', 'last_name', 'email', 'phone', 'roles', 'assigned_email', 'note', 'next_action', 'next_action_date'] as const;
export type ContactImportField = (typeof CONTACT_IMPORT_FIELDS)[number];

export const CONTACT_FIELD_LABELS: Record<ContactImportField, string> = {
  name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  roles: 'Roles (buyer, seller…)',
  assigned_email: 'Assigned agent’s email',
  note: 'Note',
  next_action: 'Next action',
  next_action_date: 'Next action date',
};

/** No single column is required: a name (full, or first/last) and an email or a phone are — checked as pairs. */
export const CONTACT_REQUIRED_FIELDS: readonly ContactImportField[] = [];

export type ContactImportMapping = Partial<Record<ContactImportField, number | null>>;
export const contactMappingSchema = z.record(z.enum(CONTACT_IMPORT_FIELDS), z.number().int().min(0).max(500).nullable());

const SYNONYMS: Record<string, ContactImportField> = {
  full_name: 'name', contact_name: 'name', contact: 'name',
  first: 'first_name', firstname: 'first_name', given_name: 'first_name',
  last: 'last_name', lastname: 'last_name', surname: 'last_name', family_name: 'last_name',
  email_address: 'email', e_mail: 'email', mail: 'email',
  mobile: 'phone', mobile_phone: 'phone', phone_number: 'phone', mobile_number: 'phone', telephone: 'phone', tel: 'phone',
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
  if (!has('email') && !has('phone')) return 'Choose a column for Email or Phone — a contact needs one of them';
  return null;
}

const ROLE_SYNONYMS: Record<string, ContactRoleKind> = { vendor: 'seller', purchaser: 'buyer', renter: 'tenant', lessee: 'tenant', lessor: 'landlord', owner: 'landlord' };

/** What a valid row becomes; the import writes exactly this through `createContact`. */
export type NormalizedContact = {
  name: string;
  email: string | null;
  phone: string | null;
  roles: ContactRoleKind[];
  assignedEmail: string | null;
  note: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
};

export type CellError = { column: string; message: string };
const EMAIL = z.string().email();

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
  if (!email && !phone) err('email', 'No email and no phone — a contact needs one of them');

  const roles: ContactRoleKind[] = [];
  for (const part of get('roles').split(/[,;|/]/).map((r) => r.trim().toLowerCase()).filter(Boolean)) {
    const role = (CONTACT_ROLES as readonly string[]).includes(part) ? (part as ContactRoleKind) : ROLE_SYNONYMS[part] ?? ROLE_SYNONYMS[part.replace(/s$/, '')] ?? ((CONTACT_ROLES as readonly string[]).includes(part.replace(/s$/, '')) ? (part.replace(/s$/, '') as ContactRoleKind) : null);
    if (!role) err('roles', `“${part}” is not a role — use buyer, seller, landlord, tenant or investor`);
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
    row: { name, email, phone, roles, assignedEmail: assigned || null, note: note || null, nextAction: nextAction || null, nextActionAt },
    errors,
  };
}

