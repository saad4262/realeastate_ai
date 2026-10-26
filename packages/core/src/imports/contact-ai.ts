import { CONTACT_ROLES } from '../contacts/contact-schema';
import {
  CONTACT_FIELD_LABELS,
  CONTACT_IMPORT_FIELDS,
  normalizeContactRow,
  type CellError,
  type ContactImportField,
  type ContactImportMapping,
  type NormalizedContact,
} from './contact-columns';

/**
 * AI help for the contacts import (ADR 0056), in two steps — this file holds everything about them
 * that is NOT a model call (non-negotiable 3: the calls live in packages/ai behind these interfaces).
 *
 *   1. Mapping: when the header synonyms leave fields unmatched, the headers and a few sample rows go
 *      to a model — the samples MASKED (letters → x, digits → 9), so no person's details leave for
 *      a mapping. The synonyms' matches stand; the model only fills what is still empty, and the
 *      screen marks those for the uploader to check.
 *   2. Cleaning, opt-in per import: ONLY the rows that fail the normal check, ONLY their mapped
 *      fields. Every proposed value must pass a guard that proves it came from the row (a phone's
 *      digits, an email's characters, a name's words), and the row is then checked by the same
 *      `normalizeContactRow` as every other row. A model never decides a row is valid.
 */

export const IMPORT_MAP_FEATURE = 'import-map';
export const IMPORT_CLEAN_FEATURE = 'import-clean';
/** Sample rows sent (masked) with the headers. */
export const SAMPLE_ROWS_FOR_AI = 5;

export type ColumnMapper = {
  model: string;
  /** Field → column index, for the fields the model could place. Throws on any failure. */
  suggest(input: {
    headers: string[];
    /** Already masked — see maskSample. */
    samples: string[][];
    importId: string;
    agencyId: string;
    userId: string | null;
  }): Promise<Partial<Record<ContactImportField, number>>>;
};

/** The fields a model may propose a value for. Free text (note, next action) is never "fixed". */
export const CLEANABLE_FIELDS = ['name', 'first_name', 'last_name', 'email', 'phone', 'roles', 'assigned_email', 'next_action_date'] as const;
export type CleanableField = (typeof CLEANABLE_FIELDS)[number];

export type RowToClean = {
  rowNumber: number;
  /** The row's mapped, cleanable cells — nothing from columns the uploader did not map. */
  values: Partial<Record<CleanableField, string>>;
  /** Why the normal check refused it, in its own words. */
  problems: string[];
};
export type RowFix = { rowNumber: number; values: Partial<Record<CleanableField, string>> };

export type RowCleaner = {
  model: string;
  /** Proposed values for the rows it could fix; rows it could not are left out. Throws on any failure. */
  clean(input: { rows: RowToClean[]; importId: string; agencyId: string; userId: string | null }): Promise<RowFix[]>;
};

// ── Step 1: mapping ─────────────────────────────────────────────────────────

/**
 * A cell's shape without its content: "Jane Smith" → "Xxxx Xxxxx", "0412 345 678" → "9999 999 999",
 * "jane@x.com" → "xxxx@x.xxx". Enough to tell an email from a phone from a date; nothing about a person.
 */
export function maskSample(value: string): string {
  // One pass: a second `\p{L}` pass would turn the X it just wrote back into x.
  return value.slice(0, 40).replace(/\p{L}|\p{N}/gu, (ch) => (/\p{N}/u.test(ch) ? '9' : /\p{Lu}/u.test(ch) ? 'X' : 'x'));
}

/** Worth asking? Only when a column with a heading went unused AND a field is still unmatched. */
export function shouldAskMapper(mapping: ContactImportMapping, headers: readonly string[]): boolean {
  const used = new Set(Object.values(mapping).filter((v): v is number => typeof v === 'number'));
  const unusedHeader = headers.some((h, i) => h.trim() !== '' && !used.has(i));
  const unmatchedField = CONTACT_IMPORT_FIELDS.some((f) => mapping[f] === null || mapping[f] === undefined);
  return unusedHeader && unmatchedField;
}

/**
 * The synonyms' mapping, with the model's suggestions filling ONLY fields still empty, and never a
 * column already used. Anything out of range or repeated is dropped, not trusted.
 */
export function mergeSuggestedMapping(
  auto: ContactImportMapping,
  suggested: Partial<Record<string, unknown>>,
  width: number,
): { mapping: ContactImportMapping; aiFields: ContactImportField[] } {
  const mapping: ContactImportMapping = { ...auto };
  const used = new Set(Object.values(auto).filter((v): v is number => typeof v === 'number'));
  const aiFields: ContactImportField[] = [];
  for (const f of CONTACT_IMPORT_FIELDS) {
    if (mapping[f] !== null && mapping[f] !== undefined) continue;
    const col = suggested[f];
    if (typeof col !== 'number' || !Number.isInteger(col) || col < 0 || col >= width || used.has(col)) continue;
    mapping[f] = col;
    used.add(col);
    aiFields.push(f);
  }
  for (const f of CONTACT_IMPORT_FIELDS) if (mapping[f] === undefined) mapping[f] = null;
  return { mapping, aiFields };
}

// ── Step 2: cleaning ────────────────────────────────────────────────────────

function fieldValues(cells: readonly string[], mapping: ContactImportMapping): Partial<Record<ContactImportField, string>> {
  const out: Partial<Record<ContactImportField, string>> = {};
  for (const f of CONTACT_IMPORT_FIELDS) {
    const i = mapping[f];
    if (i === null || i === undefined) continue;
    const v = (cells[i] ?? '').trim();
    if (v) out[f] = v;
  }
  return out;
}

/** What is sent for one failing row, or null when it has nothing a model could work with. */
export function rowToClean(rowNumber: number, cells: readonly string[], mapping: ContactImportMapping, errors: readonly CellError[]): RowToClean | null {
  const all = fieldValues(cells, mapping);
  const values: Partial<Record<CleanableField, string>> = {};
  for (const f of CLEANABLE_FIELDS) if (all[f]) values[f] = all[f];
  if (!Object.keys(values).length) return null;
  return { rowNumber, values, problems: errors.map((e) => `${e.column}: ${e.message}`) };
}

const compact = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const digitsOf = (s: string) => s.replace(/\D/g, '');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Did this value come from the row? `source` is every value that was sent for it, joined. A value
 * the guard cannot trace back is refused — the cost is a row left for the person to fix, never a
 * contact with an email or a phone number the model made up.
 */
export function acceptFix(field: CleanableField, proposed: string, source: string, original: string): boolean {
  const v = proposed.trim();
  if (!v || v.length > 200) return false;
  switch (field) {
    case 'email':
    case 'assigned_email':
      // "Jane <JANE@X.COM>", "jane @ x.com", "jane@x,com" → jane@x.com. Never a domain or a letter added.
      return compact(source).replace(/,/g, '.').includes(compact(v));
    case 'phone': {
      const d = digitsOf(v);
      // The number's last eight digits must be in the row; a country code may be added or dropped.
      return d.length >= 8 && d.length <= 13 && digitsOf(source).includes(d.slice(-8));
    }
    case 'name':
    case 'first_name':
    case 'last_name': {
      const words = v.toLowerCase().split(/[^\p{L}'-]+/u).filter(Boolean);
      const from = source.toLowerCase();
      return words.length > 0 && words.every((w) => from.includes(w));
    }
    case 'roles':
      // Read off what the cell says ("Purchaser" → buyer) — never a role for an empty cell.
      return original.trim() !== '' && v.split(/[,;|/]/).map((r) => r.trim().toLowerCase()).filter(Boolean).every((r) => (CONTACT_ROLES as readonly string[]).includes(r));
    case 'next_action_date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!m || !original.trim()) return false;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const nums = (original.match(/\d+/g) ?? []).map(Number);
      const lower = original.toLowerCase();
      const monthOk = nums.includes(mo) || (mo >= 1 && mo <= 12 && lower.includes(MONTHS[mo - 1]!));
      return (nums.includes(y) || nums.includes(y % 100)) && nums.includes(d) && monthOk;
    }
    default:
      return false;
  }
}

export type CleanedRow = { row: NormalizedContact | null; errors: CellError[]; changes: CellError[] };

/**
 * A fix applied to a row's cells: each guarded value replaces its field, then the row goes through
 * `normalizeContactRow` — the same check as every other row. `changes` are the row's warnings, one
 * per value changed, saying exactly what the model changed so the uploader can check it.
 */
export function applyFix(cells: readonly string[], mapping: ContactImportMapping, fix: RowFix, timeZone: string): CleanedRow {
  const original = fieldValues(cells, mapping);
  const sent = CLEANABLE_FIELDS.map((f) => original[f] ?? '').filter(Boolean).join(' ');
  const next: Partial<Record<ContactImportField, string>> = { ...original };
  const changes: CellError[] = [];
  for (const f of CLEANABLE_FIELDS) {
    const proposed = fix.values[f];
    if (typeof proposed !== 'string' || proposed.trim() === (original[f] ?? '')) continue;
    if (!acceptFix(f, proposed, sent, original[f] ?? '')) continue;
    next[f] = proposed.trim();
    changes.push({ column: CONTACT_FIELD_LABELS[f], message: `Fixed by AI: “${original[f] ?? ''}” → “${proposed.trim()}” — check it` });
  }
  if (!changes.length) return { row: null, errors: [], changes: [] };
  const identity = Object.fromEntries(CONTACT_IMPORT_FIELDS.map((f, i) => [f, i])) as ContactImportMapping;
  const checked = normalizeContactRow(CONTACT_IMPORT_FIELDS.map((f) => next[f] ?? ''), identity, timeZone);
  return { row: checked.row, errors: checked.errors, changes: checked.row ? changes : [] };
}
