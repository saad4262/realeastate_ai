'use server';

import { revalidatePath } from 'next/cache';
import {
  assignContact,
  ContactError,
  createContact,
  updateContact,
  type CreateContactInput,
  type UpdateContactInput,
} from '@repo/core/contacts';
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
    return { ok: true, id: contactId };
  } catch (err) {
    return failure(err, 'Could not assign the contact');
  }
}
