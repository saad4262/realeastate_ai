import { normaliseStreet } from '../listings/address-key';
import { MAX_FLOORPLANS } from '../media/links';
import { MAX_LISTING_PHOTOS } from '../media/storage-key';

/**
 * Which listing each photo in a dropped folder belongs to (ADR 0102). Pure: the browser sends only
 * paths and sizes, never files, and this decides from those and the import's rows.
 *
 * Agencies keep one folder per property, named by its address and often nested
 * (`2026 Listings/Pakenham/14 Henry Street Pakenham/Photos/1.jpg`). So each file's folders are
 * tried from the deepest up, and the first that names a row wins. Like `addressKey`, nothing is
 * guessed (ADR 0013): a folder that names two rows gets neither. A missing photo is fixed in a
 * minute, while one vendor's house on another's ad is not.
 */

export type FolderFile = { path: string; size: number };
export type MatchRow = {
  rowId: string;
  rowNumber: number;
  externalId: string | null;
  unit?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  suburb: string;
  state: string;
  postcode: string;
  /** The file gave this row photo links: those are used, and a folder is not. */
  hasLinks: boolean;
};
export type PlannedPhoto = { path: string; size: number; kind?: 'floorplan' };
export type FolderMatch = {
  byRow: Map<string, PlannedPhoto[]>;
  /** Folders holding photos that named no row: the deepest folder of each such photo. */
  unmatchedFolders: string[];
  ambiguous: { folder: string; rows: number[] }[];
  skipped: { path: string; reason: string }[];
  /** Rows a folder matched that keep their links from the file instead. */
  linksWin: number[];
};

export const MAX_FOLDER_FILES = 30_000;
/** Before the browser shrinks it. Past this a phone or camera original is not what was meant. */
export const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;

const IMAGE = /\.(jpe?g|png|webp|avif)$/i;
const HEIC = /\.(heic|heif)$/i;
const JUNK = new Set(['__macosx', 'thumbs.db', 'desktop.ini']);
const UNIT_WORDS = new Set(['unit', 'apartment', 'apt', 'flat', 'villa', 'townhouse', 'u']);
const FLOORPLAN = /floor[\s_-]*plan/i;

/** The same folding as `addressKey`, with `-`, `/` and `_` as spaces, so "2-6E" and "2/6E" are unit 2 of 6E. */
function words(s: string | null | undefined): string[] {
  return normaliseStreet((s ?? '').replace(/[_\-/()]/g, ' ')).split(' ').filter(Boolean);
}

/** "Unit 2", "Apt 2" and "U2" in front are all "2". */
function dropUnitWord(t: string[]): string[] {
  if (t.length > 1 && UNIT_WORDS.has(t[0]!)) return t.slice(1);
  if (/^u\d/.test(t[0] ?? '')) return [t[0]!.slice(1), ...t.slice(1)];
  return t;
}

function rowWords(r: MatchRow): string[] {
  return [...dropUnitWord(words(r.unit)), ...words(r.streetNumber), ...words(r.street)];
}

const naturally = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function matchFolder(rows: MatchRow[], files: FolderFile[]): FolderMatch {
  // Rows by their first two words, so a folder is compared with a handful of rows, not every one.
  const byLead = new Map<string, { row: MatchRow; words: string[]; place: Set<string> }[]>();
  const byExternal = new Map<string, MatchRow[]>();
  for (const r of rows) {
    const w = rowWords(r);
    // One word ("Henry Street" with no number) would match too much.
    if (w.length >= 2) {
      const place = new Set([...words(r.suburb), r.state.trim().toLowerCase(), r.postcode.trim()]);
      const lead = `${w[0]} ${w[1]}`;
      byLead.set(lead, [...(byLead.get(lead) ?? []), { row: r, words: w, place }]);
    }
    const ext = r.externalId?.trim().toLowerCase();
    if (ext) byExternal.set(ext, [...(byExternal.get(ext) ?? []), r]);
  }

  const named = new Map<string, MatchRow[]>();
  /** The rows a folder name names: its address (plus only that row's suburb, state or postcode), or its external id. */
  const rowsNamedBy = (name: string): MatchRow[] => {
    const hit = named.get(name);
    if (hit) return hit;
    const f = dropUnitWord(words(name));
    const found = new Set<MatchRow>(byExternal.get(name.trim().toLowerCase()) ?? []);
    for (const c of byLead.get(`${f[0]} ${f[1]}`) ?? []) {
      if (c.words.every((w, i) => f[i] === w) && f.slice(c.words.length).every((w) => c.place.has(w))) found.add(c.row);
    }
    named.set(name, [...found]);
    return [...found];
  };

  const byRow = new Map<string, PlannedPhoto[]>();
  const unmatched = new Set<string>();
  const ambiguous = new Map<string, number[]>();
  const skipped: FolderMatch['skipped'] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    const name = parts.at(-1) ?? '';
    if (seen.has(file.path) || parts.some((p) => p.startsWith('.') || JUNK.has(p.toLowerCase()))) continue;
    seen.add(file.path);
    if (HEIC.test(name)) {
      skipped.push({ path: file.path, reason: 'An iPhone HEIC photo: save it as JPEG first' });
      continue;
    }
    if (!IMAGE.test(name)) continue;
    if (file.size > MAX_ORIGINAL_BYTES) {
      skipped.push({ path: file.path, reason: 'Larger than 40 MB' });
      continue;
    }
    const dirs = parts.slice(0, -1);
    let placed = false;
    for (let i = dirs.length; i >= 1; i--) {
      const hit = rowsNamedBy(dirs[i - 1]!);
      if (!hit.length) continue;
      const folder = dirs.slice(0, i).join('/');
      if (hit.length > 1) {
        ambiguous.set(folder, hit.map((r) => r.rowNumber).sort((a, b) => a - b));
      } else {
        const rel = parts.slice(i).join('/');
        const list = byRow.get(hit[0]!.rowId) ?? [];
        list.push({ path: file.path, size: file.size, ...(FLOORPLAN.test(rel) ? { kind: 'floorplan' as const } : {}) });
        byRow.set(hit[0]!.rowId, list);
      }
      placed = true;
      break;
    }
    if (!placed) unmatched.add(dirs.join('/') || '(top of the folder)');
  }

  // Natural order from inside the property's folder ("2.jpg" before "10.jpg"), then the limits.
  const linksWin: number[] = [];
  const rowsById = new Map(rows.map((r) => [r.rowId, r]));
  for (const [rowId, list] of byRow) {
    const row = rowsById.get(rowId)!;
    if (row.hasLinks) {
      linksWin.push(row.rowNumber);
      byRow.delete(rowId);
      continue;
    }
    list.sort((a, b) => naturally(a.path, b.path));
    let photos = 0;
    let plans = 0;
    const kept = list.filter((p) => {
      const ok = p.kind === 'floorplan' ? ++plans <= MAX_FLOORPLANS : ++photos <= MAX_LISTING_PHOTOS;
      if (!ok) skipped.push({ path: p.path, reason: p.kind === 'floorplan' ? `Not used: a listing carries ${MAX_FLOORPLANS} floorplans` : `Not used: a listing carries ${MAX_LISTING_PHOTOS} photos` });
      return ok;
    });
    byRow.set(rowId, kept);
  }

  return {
    byRow,
    unmatchedFolders: [...unmatched].sort(naturally),
    ambiguous: [...ambiguous].map(([folder, r]) => ({ folder, rows: r })),
    skipped,
    linksWin: linksWin.sort((a, b) => a - b),
  };
}
