import { z } from 'zod';
import type { DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { QUERY_MAX_CHARS } from './guard';
import { runOpenQuery, type OpenCell, type OpenColumnType } from './run';
import { missingAgents } from './complete';

/**
 * An open tile (ADR 0042 Part F): the model's query, saved with its title, a one-line
 * explanation and how to draw it. Re-checked by the parser and run AS THE VIEWER (their
 * ticket, their scope) on every render; display columns carry the text, because the
 * tile is drawn for the person, never handed to a model.
 */

export const OPEN_VIZ = ['number', 'table', 'bar', 'line', 'donut'] as const;
export const OPEN_FORMATS = ['number', 'money', 'percent', 'decimal', 'text', 'date', 'datetime', 'list'] as const;
export type OpenViz = (typeof OPEN_VIZ)[number];
export type OpenFormat = (typeof OPEN_FORMATS)[number];

export const openTileSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    /** In plain words, how the figure is worked out ("New leads per day, averaged over the last 30 days"). */
    explanation: z.string().trim().min(1).max(300),
    sql: z.string().trim().min(1).max(QUERY_MAX_CHARS),
    viz: z.enum(OPEN_VIZ).default('table'),
    /** `agents`: one row per agent — every active agent must be in it (Part G). */
    rows_are: z.enum(['agents', 'other']).default('other'),
    /** Labels and formats by result column; columns not named here are drawn by their type, `*_id` hidden. */
    columns: z
      .array(z.object({ key: z.string().trim().min(1).max(63), label: z.string().trim().min(1).max(60), format: z.enum(OPEN_FORMATS).optional() }).strict())
      .max(16)
      .default([]),
  })
  .strict();
export type OpenTileSpec = z.infer<typeof openTileSchema>;

export type OpenTileColumn = { key: string; label: string; format: OpenFormat; hidden: boolean };
export type OpenTileData = {
  kind: 'open';
  viz: OpenViz;
  explanation: string;
  columns: OpenTileColumn[];
  rows: OpenCell[][];
  truncated: boolean;
  /** The agency's clock, so a date reads the same on the server and in the browser. */
  timeZone: string;
  /** Part G: active agents a per-agent tile left out — drawn as a warning, never silently. */
  missing: string[];
  /** The query itself, for owners and admins ("Show query"). */
  sql?: string;
  /** The tile no longer passes (the data model changed): "needs rebuilding", no stale figure. */
  problem?: string;
};

/** Postgres cancelled it for time: the registry turns this into a "too slow" tile. */
export class OpenTileTimeout extends Error {
  readonly code = '57014';
}

const FORMAT_BY_TYPE: Record<OpenColumnType, OpenFormat> = { number: 'number', text: 'text', date: 'datetime', boolean: 'text', list: 'list' };

export const labelFor = (key: string) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export async function runOpenTile(db: DbOrTx, actor: Actor, spec: OpenTileSpec, timeZone = 'Australia/Sydney'): Promise<OpenTileData> {
  const base = { kind: 'open' as const, viz: spec.viz, explanation: spec.explanation, timeZone };
  const showSql = Boolean(actor.agencyId) && can(actor, 'dashboard:create', { type: 'dashboard', agencyId: actor.agencyId ?? '' });
  const res = await runOpenQuery(db, actor, spec.sql, { mode: 'person', via: 'tile' });
  if (!res.ok) {
    if (res.outcome === 'too_slow') throw new OpenTileTimeout(res.problem);
    return { ...base, columns: [], rows: [], truncated: false, missing: [], ...(showSql ? { sql: spec.sql } : {}), problem: res.problem };
  }
  const named = new Map(spec.columns.map((c) => [c.key, c]));
  const columns: OpenTileColumn[] = res.columns.map((c) => {
    const n = named.get(c.name);
    return { key: c.name, label: n?.label ?? labelFor(c.name), format: n?.format ?? FORMAT_BY_TYPE[c.type], hidden: !n && /(^|_)id$/.test(c.name) };
  });
  const missing = spec.rows_are === 'agents' && !res.truncated ? (await missingAgents(db, actor, res.columns, res.rows)).map((m) => m.name) : [];
  return { ...base, columns, rows: res.rows, truncated: res.truncated, missing, ...(showSql ? { sql: spec.sql } : {}) };
}

/** For a card or a chat line: the shape of the result, never a cell's text (display columns may hold other people's words). */
export function openTileSummary(d: OpenTileData): string {
  if (d.problem) return 'Needs rebuilding';
  if (d.viz === 'number') {
    const at = d.columns.findIndex((c) => c.format !== 'text' && c.format !== 'list' && !c.hidden);
    const v = at >= 0 ? d.rows[0]?.[at] : null;
    return typeof v === 'number' ? String(v) : 'No information yet';
  }
  return `${d.rows.length}${d.truncated ? '+' : ''} row${d.rows.length === 1 ? '' : 's'}${d.missing.length ? ` · ${d.missing.length} agent${d.missing.length === 1 ? '' : 's'} missing` : ''}`;
}
