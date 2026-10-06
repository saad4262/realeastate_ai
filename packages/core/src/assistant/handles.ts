import { HANDLE_KINDS, type HandleKind, type HandlePrefix } from './schema';

/**
 * The server's map from the short names the model sees (`C1`, `L3`, `S1`) to
 * row ids (ADR 0025 §3). Stored on the conversation, so a name means the same
 * row on every turn. Only this module mints names; the model can only repeat
 * one it was given.
 */
export type HandleMap = Record<string, { k: HandleKind; id: string }>;

export function parseHandleMap(raw: unknown): HandleMap {
  const out: HandleMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const entry = v as { k?: unknown; id?: unknown } | null;
    const prefix = name[0] as HandlePrefix;
    if (!entry || typeof entry.id !== 'string' || !(prefix in HANDLE_KINDS)) continue;
    if (entry.k !== HANDLE_KINDS[prefix]) continue;
    out[name] = { k: HANDLE_KINDS[prefix], id: entry.id };
  }
  return out;
}

/**
 * The name for this row, minting the next one for its prefix if it has none.
 * The same row keeps the same name for the whole conversation.
 */
export function issueHandle(map: HandleMap, prefix: HandlePrefix, id: string): string {
  const existing = Object.entries(map).find(([name, v]) => name[0] === prefix && v.id === id);
  if (existing) return existing[0];
  let n = 1;
  for (const name of Object.keys(map)) {
    if (name[0] === prefix) n = Math.max(n, Number(name.slice(1)) + 1);
  }
  const name = `${prefix}${n}`;
  map[name] = { k: HANDLE_KINDS[prefix], id };
  return name;
}

/**
 * The id a name stands for, if this conversation issued it for that kind of
 * row. Null otherwise — the caller says "unknown reference" and finds nothing.
 * Visibility is NOT decided here: the scoped query that uses the id decides.
 */
export function resolveHandle(map: HandleMap, name: string, kind: HandleKind): string | null {
  const entry = map[name];
  return entry && entry.k === kind ? entry.id : null;
}
