import { z } from 'zod';
import { RENOVATION_CATEGORY_KEYS, isRenovationCategoryKey, type RenovationCategoryKey } from './categories';

/**
 * The model's two jobs in Renovation AI (ADR 0080, C3) and the contracts that bind them. The model (packages/ai,
 * #3) returns these shapes; core keeps only what the rules allow.
 *
 * 1. The plan (decision 2): the buyer's words → kinds of work from the fixed list, one line each in the buyer's
 *    terms. An unknown kind is dropped, never mapped; a line with a price or a rate is dropped (decision 1).
 * 2. The photos (decision 3): which ROOM each photo shows — nothing else. The schema is strict, so an answer
 *    that adds a condition, an age, a defect or a material is refused whole, not trimmed.
 */

export const MAX_PLAN_ITEMS = 10;

export const planDraftSchema = z
  .object({
    items: z
      .array(z.object({ category: z.string().trim().min(1).max(40), note: z.string().trim().min(1).max(240) }).strict())
      .max(20),
  })
  .strict();
export type PlanDraft = z.infer<typeof planDraftSchema>;

export type PlanItem = { category: RenovationCategoryKey; note: string };

/**
 * Money in any form: a dollar sign, "AUD", "dollars", "$20k" style shorthand, or a rate per square metre. Digits
 * on their own are allowed — a buyer's "5 × 4 m deck" is a size, not a price.
 */
const MONEY = /\$|\baud\b|\bdollars?\b|\bbucks\b|\b\d+(?:\.\d+)?\s?k\b|\bper\s?(?:m2|m²|sqm|square\s?met(?:re|er))\b|\/\s?(?:m2|m²|sqm)\b/i;

export function mentionsMoney(text: string): boolean {
  return MONEY.test(text);
}

/** Keep the known kinds of work, once each, in the model's order, with no money in the line. Pure. */
export function checkPlan(draft: PlanDraft): PlanItem[] {
  const seen = new Set<RenovationCategoryKey>();
  const out: PlanItem[] = [];
  for (const item of draft.items) {
    const key = item.category.trim().toLowerCase();
    if (!isRenovationCategoryKey(key) || seen.has(key)) continue;
    const note = item.note.replace(/\s+/g, ' ').trim();
    if (mentionsMoney(note)) continue;
    seen.add(key);
    out.push({ category: key, note });
    if (out.length >= MAX_PLAN_ITEMS) break;
  }
  return out;
}

/** The categories the model is shown, as `key — description` lines. Stable order: the catalog's. */
export const PLAN_CATEGORY_KEYS: readonly RenovationCategoryKey[] = RENOVATION_CATEGORY_KEYS;

export const ROOM_TYPES = [
  'kitchen',
  'bathroom',
  'ensuite',
  'toilet',
  'laundry',
  'bedroom',
  'living',
  'dining',
  'study',
  'garage',
  'deck',
  'balcony',
  'pool',
  'garden',
  'front_exterior',
  'other',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

/** One label per photo. `.strict()` on purpose: a key beyond these two — "condition", "age" — refuses the answer. */
export const photoRoomsSchema = z
  .object({
    photos: z.array(z.object({ photo: z.number().int().min(1).max(60), room: z.enum(ROOM_TYPES) }).strict()).max(60),
  })
  .strict();
export type PhotoRooms = z.infer<typeof photoRoomsSchema>;

/**
 * What the photos show, counted by code: each room type once with how many photos show it, in ROOM_TYPES order.
 * Only photos that were actually sent count — a label for photo 9 of 6 is ignored. "other" is left out. Pure.
 */
export function roomsFromPhotos(answer: PhotoRooms, photosSent: number): { room: RoomType; photos: number }[] {
  const counts = new Map<RoomType, Set<number>>();
  for (const p of answer.photos) {
    if (p.photo > photosSent || p.room === 'other') continue;
    counts.set(p.room, (counts.get(p.room) ?? new Set()).add(p.photo));
  }
  return ROOM_TYPES.filter((r) => counts.has(r)).map((room) => ({ room, photos: counts.get(room)!.size }));
}
