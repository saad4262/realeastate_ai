import { z } from 'zod';

/**
 * Inspection Assistant's checklist (ADR 0080, C6 decision 7): fixed, in our own words, never written by the AI. A
 * house version and an apartment version; the apartment one swaps the yard for the building and adds strata items
 * (the state's due-diligence checklist, C2, is linked beside it). Each item is marked "Looks fine", "Issue" or
 * "Didn't check", with an optional note in the buyer's words.
 */

export const CHECK_MARKS = ['fine', 'issue', 'unchecked'] as const;
export type CheckMark = (typeof CHECK_MARKS)[number];
export const CHECK_MARK_LABEL: Record<CheckMark, string> = { fine: 'Looks fine', issue: 'Issue', unchecked: "Didn't check" };

export type ChecklistKind = 'house' | 'apartment';
export type ChecklistItem = { key: string; group: string; label: string };

const OUTSIDE_HOUSE: ChecklistItem[] = [
  { key: 'roof_gutters', group: 'Outside', label: 'Roof and gutters' },
  { key: 'wall_cracks', group: 'Outside', label: 'Cracks in walls, paths or ceilings' },
  { key: 'drainage', group: 'Outside', label: 'Water pooling or drainage' },
  { key: 'fences', group: 'Outside', label: 'Fences and boundaries' },
];
const OUTSIDE_APARTMENT: ChecklistItem[] = [
  { key: 'building_outside', group: 'The building', label: 'Outside of the building (cracks, stains)' },
  { key: 'wall_cracks', group: 'The building', label: 'Cracks in walls or ceilings' },
  { key: 'balcony', group: 'The building', label: 'Balcony and balustrade' },
  { key: 'common_areas', group: 'The building', label: 'Common areas (lifts, stairs, bins)' },
];
const INSIDE: ChecklistItem[] = [
  { key: 'damp_mould', group: 'Inside', label: 'Damp or mould (look and smell)' },
  { key: 'water_pressure', group: 'Inside', label: 'Water pressure and hot water' },
  { key: 'doors_windows', group: 'Inside', label: 'Doors and windows open and close' },
  { key: 'floors', group: 'Inside', label: 'Floors (soft spots, slope)' },
  { key: 'heating_cooling', group: 'Inside', label: 'Heating and cooling' },
  { key: 'storage', group: 'Inside', label: 'Storage and wardrobes' },
  { key: 'light', group: 'Inside', label: 'Natural light' },
];
const SERVICES: ChecklistItem[] = [
  { key: 'power_board', group: 'Services', label: 'Power board and power points' },
  { key: 'smoke_alarms', group: 'Services', label: 'Smoke alarms' },
  { key: 'internet', group: 'Services', label: 'Phone signal and NBN point' },
];
const STREET: ChecklistItem[] = [
  { key: 'noise', group: 'The street', label: 'Noise from the street or neighbours' },
  { key: 'parking', group: 'The street', label: 'Parking' },
];
const STRATA: ChecklistItem[] = [
  { key: 'car_space', group: 'Strata', label: 'Your car space and storage cage' },
  { key: 'strata_records', group: 'Strata', label: 'Asked for the strata (owners corporation) records' },
];

export const CHECKLISTS: Record<ChecklistKind, readonly ChecklistItem[]> = {
  house: [...OUTSIDE_HOUSE, ...INSIDE, ...SERVICES, ...STREET],
  apartment: [...OUTSIDE_APARTMENT, ...INSIDE, ...SERVICES, ...STREET, ...STRATA],
};

/** Every key either list uses: what a stored mark may be keyed by. */
export const CHECK_KEYS = [...new Set([...CHECKLISTS.house, ...CHECKLISTS.apartment].map((i) => i.key))] as [string, ...string[]];

/** Apartment-like homes get the apartment list. Pure. */
export function checklistKind(propertyType: string | null): ChecklistKind {
  return /apartment|unit|flat|studio|penthouse/i.test(propertyType ?? '') ? 'apartment' : 'house';
}

export const MAX_CHECK_NOTE = 200;
export const MAX_NOTES = 4000;

export const checkEntrySchema = z.object({ mark: z.enum(CHECK_MARKS), note: z.string().trim().max(MAX_CHECK_NOTE).optional() }).strict();
export const checksSchema = z.record(z.enum(CHECK_KEYS), checkEntrySchema);
export type Checks = z.infer<typeof checksSchema>;

/** What a save may carry: the marks (whole), the notes, or both. */
export const inspectionNotePatchSchema = z
  .object({ checks: checksSchema.optional(), notes: z.string().max(MAX_NOTES).optional() })
  .strict()
  .refine((v) => v.checks !== undefined || v.notes !== undefined, 'Nothing to save');
export type InspectionNotePatch = z.infer<typeof inspectionNotePatchSchema>;

/** Stored marks, read back: anything that no longer parses is left out rather than failing the page. Pure. */
export function readChecks(raw: unknown): Checks {
  if (!raw || typeof raw !== 'object') return {};
  const out: Checks = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(CHECK_KEYS as readonly string[]).includes(k)) continue;
    const e = checkEntrySchema.safeParse(v);
    if (e.success) out[k] = e.data;
  }
  return out;
}
