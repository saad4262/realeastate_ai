'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import {
  assignContact,
  ContactError,
  createContact,
  createNote,
  deleteNote,
  linkContactProperty,
  mergeContacts,
  notifyContactAssigned,
  searchLinkableProperties,
  setContactArchived,
  setNextAction,
  unlinkContactProperty,
  updateContact,
  updateNote,
  type CreateContactInput,
  type LinkPropertyInput,
  type NextActionInput,
  type PropertyMatch,
  type UpdateContactInput,
} from '@repo/core/contacts';
import { noticeMailFromEnv } from '@repo/core/email';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

export type ContactActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; existingId?: string };

/**
 * The contact actions (docs/adr/0018).
 *
 * The actor is rebuilt from the session on every call, never taken from the
 * browser. No listing links are needed: who may see or edit a contact is
 * decided from facts loaded with the contact itself. Every decision is can()'s,
 * inside packages/core; this layer only translates the outcome for the form.
 */
async function actor() {
  // Outside any try: a missing session must read as signed out.
  const userId = await requireActionUserId();
  const loaded = await loadActor(userId);
  if (!loaded) throw new ContactError('forbidden', 'Database is not configured.');
  return loaded;
}

function refresh(id?: string) {
  revalidatePath('/customers');
  revalidatePath('/my-contacts');
  if (id) {
    revalidatePath(`/customers/${id}`);
    revalidatePath(`/my-contacts/${id}`);
  }
}

function failure(err: unknown, fallback: string): ContactActionResult {
  if (err instanceof ContactError) {
    return { ok: false, error: err.message, ...(err.existingId ? { existingId: err.existingId } : {}) };
  }
  console.error('[contacts] action failed', err);
  return { ok: false, error: fallback };
}

export async function createContactAction(input: CreateContactInput): Promise<ContactActionResult> {
  const who = await actor();
  try {
    const { id } = await createContact(getConsoleDb(), who, input);
    refresh(id);
    // An admin adding a contact for somebody else tells them (not themselves).
    if (input.assignedTo) emailAssigneeAfter(id, input.assignedTo, who.userId);
    return { ok: true, id };
  } catch (err) {
    return failure(err, 'Could not add the contact');
  }
}

export async function updateContactAction(
  contactId: string,
  input: UpdateContactInput,
): Promise<ContactActionResult> {
  const who = await actor();
  try {
    await updateContact(getConsoleDb(), who, contactId, input);
    refresh(contactId);
    return { ok: true, id: contactId };
  } catch (err) {
    return failure(err, 'Could not save the contact');
  }
}

export async function assignContactAction(
  contactId: string,
  assignTo: string | null,
): Promise<ContactActionResult> {
  const who = await actor();
  try {
    await assignContact(getConsoleDb(), who, contactId, assignTo);
    refresh(contactId);
    if (assignTo) emailAssigneeAfter(contactId, assignTo, who.userId);
    return { ok: true, id: contactId };
  } catch (err) {
    return failure(err, 'Could not assign the contact');
  }
}

/**
 * "This contact is now yours", after the response: the picker must not wait
 * on Resend, and a failed email must not read as a failed assignment. The
 * notice itself skips self-assignment and re-checks it is still theirs.
 */
function emailAssigneeAfter(contactId: string, assigneeId: string, assignedBy: string) {
  if (assigneeId === assignedBy) return;
  after(async () => {
    const mail = noticeMailFromEnv();
    if (!mail) return;
    try {
      await notifyContactAssigned(getConsoleDb(), mail, contactId, assigneeId, assignedBy);
    } catch (err) {
      console.error(`[contact-notice] assignment notice for contact ${contactId} failed`, err);
    }
  });
}

export type SimpleResult = { ok: true } | { ok: false; error: string };

function simpleFailure(err: unknown, fallback: string): SimpleResult {
  if (err instanceof ContactError) return { ok: false, error: err.message };
  console.error('[contacts] action failed', err);
  return { ok: false, error: fallback };
}

export async function setNextActionAction(contactId: string, input: NextActionInput): Promise<SimpleResult> {
  const who = await actor();
  try {
    await setNextAction(getConsoleDb(), who, contactId, input);
    refresh(contactId);
    return { ok: true };
  } catch (err) {
    return simpleFailure(err, 'Could not save the next action');
  }
}

export async function setArchivedAction(contactId: string, archived: boolean): Promise<SimpleResult> {
  const who = await actor();
  try {
    await setContactArchived(getConsoleDb(), who, contactId, archived);
    refresh(contactId);
    return { ok: true };
  } catch (err) {
    return simpleFailure(err, archived ? 'Could not archive the contact' : 'Could not restore the contact');
  }
}

/** Fold `loserId` into `survivorId`. Admins only — decided in core. */
export async function mergeContactsAction(survivorId: string, loserId: string): Promise<SimpleResult> {
  const who = await actor();
  try {
    await mergeContacts(getConsoleDb(), who, survivorId, loserId);
    refresh(survivorId);
    refresh(loserId);
    return { ok: true };
  } catch (err) {
    return simpleFailure(err, 'Could not merge the contacts');
  }
}

export async function createNoteAction(contactId: string, body: string): Promise<SimpleResult> {
  const who = await actor();
  try {
    await createNote(getConsoleDb(), who, contactId, body);
    refresh(contactId);
    return { ok: true };
  } catch (err) {
    return simpleFailure(err, 'Could not save the note');
  }
}

export async function updateNoteAction(noteId: string, body: string): Promise<SimpleResult> {
  const who = await actor();
  try {
    const { contactId } = await updateNote(getConsoleDb(), who, noteId, body);
    refresh(contactId);
    return { ok: true };
  } catch (err) {
    return simpleFailure(err, 'Could not save the note');
  }
}

export async function deleteNoteAction(noteId: string): Promise<SimpleResult> {
  const who = await actor();
  try {
    const { contactId } = await deleteNote(getConsoleDb(), who, noteId);
    refresh(contactId);
    return { ok: true };
  } catch (err) {
    return simpleFailure(err, 'Could not delete the note');
  }
}

export async function searchPropertiesAction(q: string): Promise<PropertyMatch[]> {
  const who = await actor();
  try {
    return await searchLinkableProperties(getConsoleDb(), who, q);
  } catch (err) {
    console.error('[contacts] property search failed', err);
    return [];
  }
}

export async function linkPropertyAction(contactId: string, input: LinkPropertyInput): Promise<SimpleResult> {
  const who = await actor();
  try {
    await linkContactProperty(getConsoleDb(), who, contactId, input);
    refresh(contactId);
    return { ok: true };
  } catch (err) {
    return simpleFailure(err, 'Could not link the property');
  }
}

export async function unlinkPropertyAction(contactId: string, linkId: string): Promise<SimpleResult> {
  const who = await actor();
  try {
    await unlinkContactProperty(getConsoleDb(), who, contactId, linkId);
    refresh(contactId);
    return { ok: true };
  } catch (err) {
    return simpleFailure(err, 'Could not unlink the property');
  }
}
