import { and, count, eq, gte, sql, type SQL } from 'drizzle-orm';
import { aiQueryLog, aiQueryTicket, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { checkQuery } from './guard';
import { AI_VIEW_NAMES, datasetCtes, OPEN_DATASET_NAMES, OPEN_DATASETS, type QueryMode } from './datasets';

/**
 * Running one model-written query (ADR 0042). In order:
 *   permission (`report:query`) → the hourly cap → L1 the parser → L2 the datasets as
 *   this person → ONE transaction that inserts this query's own ticket, then makes itself
 *   read-only, 5 s, search_path `ai`, role `ai_reader` (L3, L5) and names the ticket
 *   (L4) → the query → ROLLBACK, always (the ticket is never committed).
 * Every figure is what Postgres returned (#4). Nothing here calls a model.
 */

export const OPEN_QUERY_LIMITS = {
  /** Rows kept for a tile. */
  rowsKept: 500,
  /** Rows handed back to the model. */
  rowsToModel: 50,
  /**
   * Open queries an agency's assistant may run in an hour (tiles on a dashboard are not counted). Room
   * for a request of ten parts with its corrections (ADR 0044 E); a cap on load, not a lock.
   */
  perAgencyPerHour: 150,
  statementTimeout: '5s',
} as const;

export type OpenColumnType = 'number' | 'text' | 'date' | 'boolean' | 'list';
export type OpenColumn = { name: string; type: OpenColumnType };
export type OpenCell = string | number | boolean | string[] | null;

export type OpenQueryResult =
  | { ok: true; columns: OpenColumn[]; rows: OpenCell[][]; rowCount: number; truncated: boolean; ms: number; datasets: string[] }
  | { ok: false; outcome: 'forbidden' | 'capped' | 'rejected' | 'error' | 'too_slow'; problem: string };

export type OpenQueryOptions = {
  /** `model`: display columns hold a placeholder (the assistant's own runs). `person`: the text (a tile). */
  mode: QueryMode;
  via: 'assistant' | 'tile';
  maxRows?: number;
};

const DONE = Symbol('open query done');

export async function runOpenQuery(db: DbOrTx, actor: Actor, text: string, opts: OpenQueryOptions): Promise<OpenQueryResult> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'report:query', { type: 'report', agencyId })) {
    return { ok: false, outcome: 'forbidden', problem: 'This person may not ask open questions of the agency’s data.' };
  }
  const query = text.trim().replace(/;\s*$/, '');

  if (opts.via === 'assistant') {
    const since = new Date(Date.now() - 3_600_000);
    const [used] = await db
      .select({ n: count() })
      .from(aiQueryLog)
      .where(and(eq(aiQueryLog.agencyId, agencyId), eq(aiQueryLog.via, 'assistant'), gte(aiQueryLog.createdAt, since)));
    if ((used?.n ?? 0) >= OPEN_QUERY_LIMITS.perAgencyPerHour) {
      await log(db, actor, opts, query, 'capped', null);
      return { ok: false, outcome: 'capped', problem: `The agency has asked ${OPEN_QUERY_LIMITS.perAgencyPerHour} open questions in the last hour — the limit. Try again a little later.` };
    }
  }

  const checked = await checkQuery(query, OPEN_DATASET_NAMES, AI_VIEW_NAMES);
  if (!checked.ok) {
    await log(db, actor, opts, query, 'rejected', checked.problem);
    return { ok: false, outcome: 'rejected', problem: checked.problem };
  }

  const keep = Math.min(opts.maxRows ?? OPEN_QUERY_LIMITS.rowsKept, OPEN_QUERY_LIMITS.rowsKept);
  // The checked text, exactly, on lines of its own (a trailing `--` comment cannot reach the bracket).
  const statement = sql`${datasetCtes(db as Db, actor, checked.datasets, opts.mode)} select * from (\n${sql.raw(query)}\n) as q limit ${keep + 1}`;

  const started = Date.now();
  let raw: ReaderRows;
  try {
    raw = await runAsReader(db, actor, statement);
  } catch (err) {
    const code = pgCode(err);
    const outcome = code === '57014' ? 'too_slow' : 'error';
    const problem =
      outcome === 'too_slow'
        ? 'The query ran longer than 5 seconds and was stopped. Make it simpler: aggregate each dataset in its own CTE first and join the small results, use a shorter period, or avoid correlated subqueries per row.'
        : `Postgres refused the query: ${pgMessage(err)}${errorHint(pgMessage(err), checked.datasets)}`;
    await log(db, actor, opts, query, outcome, problem, Date.now() - started);
    return { ok: false, outcome, problem };
  }
  const ms = Date.now() - started;
  const { rows: all, columns: cols } = raw;
  const names = cols.length ? cols.map((c) => c.name) : Object.keys(all[0] ?? {});
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) {
    const problem = `Two columns are both called "${dup}". Give each column its own name with AS.`;
    await log(db, actor, opts, query, 'rejected', problem, ms);
    return { ok: false, outcome: 'rejected', problem };
  }
  const columns: OpenColumn[] = names.map((name, i) => ({ name, type: columnType(cols[i]?.type) }));
  const truncated = all.length > keep;
  const rows = all.slice(0, keep).map((r) => columns.map((c) => cell(r[c.name], c.type)));
  if (opts.via === 'assistant') await log(db, actor, opts, query, 'ok', null, ms, rows.length);
  return { ok: true, columns, rows, rowCount: rows.length, truncated, ms, datasets: checked.datasets };
}

type ReaderRows = { rows: Record<string, unknown>[]; columns: { name: string; type: number }[] };

/**
 * L3–L5 with NO parser in front: one transaction that inserts this statement's own ticket
 * (never committed), makes itself read-only with a timeout, reads only the `ai` schema as
 * `ai_reader`, runs the statement, and rolls back. `runOpenQuery` is the only caller in
 * the app; the smoke suite calls it directly to prove the locks hold with L1 switched off.
 */
export async function runAsReader(db: DbOrTx, actor: Actor, statement: SQL): Promise<ReaderRows> {
  let out: ReaderRows | undefined;
  try {
    await db.transaction(async (tx) => {
      const [ticket] = await tx.insert(aiQueryTicket).values({ agencyId: actor.agencyId!, userId: actor.userId }).returning({ id: aiQueryTicket.id });
      await tx.execute(sql`select
        set_config('statement_timeout', ${OPEN_QUERY_LIMITS.statementTimeout}, true),
        set_config('lock_timeout', '1s', true),
        set_config('search_path', 'ai', true),
        set_config('ai.ticket', ${ticket!.id}, true),
        set_config('transaction_read_only', 'on', true),
        set_config('role', 'ai_reader', true)`);
      const res = (await tx.execute(statement)) as unknown as Record<string, unknown>[] & { columns?: { name: string; type: number }[] };
      out = { rows: [...res], columns: (res.columns ?? []).map((c) => ({ name: c.name, type: c.type })) };
      throw DONE;
    });
  } catch (err) {
    if (err !== DONE) throw err;
  }
  return out!;
}

/** Postgres type oids → how a cell is shown. Arrays are lists of text. */
function columnType(oid: number | undefined): OpenColumnType {
  switch (oid) {
    case 20: case 21: case 23: case 700: case 701: case 1700:
      return 'number';
    case 16:
      return 'boolean';
    case 1082: case 1114: case 1184:
      return 'date';
    case 1009: case 1015: case 1007: case 1016: case 1005: case 2951: case 1231:
      return 'list';
    default:
      return 'text';
  }
}

function cell(v: unknown, type: OpenColumnType): OpenCell {
  if (v === null || v === undefined) return null;
  if (type === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') return Boolean(v);
  if (type === 'date') return v instanceof Date ? v.toISOString() : String(v);
  if (type === 'list') return Array.isArray(v) ? v.map((x) => (x === null ? '' : String(x))) : String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function pgCode(err: unknown): string | undefined {
  const get = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined);
  return get(err) ?? get((err as { cause?: unknown } | null)?.cause);
}

function pgMessage(err: unknown): string {
  const e = ((err as { cause?: unknown } | null)?.cause ?? err) as { message?: string } | null;
  // Drizzle wraps the error with the whole statement ("Failed query: …"); only Postgres's own words go back.
  const msg = (e?.message ?? 'unknown error').replace(/^Failed query:[\s\S]*?\nparams:.*\n?/, '');
  return msg.slice(0, 300);
}

/**
 * ADR 0044 D: a hint after Postgres's own words, so the model can correct the query in one go.
 * Built from the dataset definitions; it never reveals anything the dictionary does not.
 */
export function errorHint(message: string, used: string[]): string {
  const m = message.toLowerCase();
  if (/column .* does not exist/.test(m)) {
    const cols = OPEN_DATASETS.filter((d) => used.includes(d.name))
      .map((d) => `${d.name}(${d.columns.map((c) => c.name).join(', ')})`)
      .join('; ');
    return ` Hint: the columns of the datasets this query reads are ${cols}. A column of your own CTE must be selected in it, with that name.`;
  }
  if (/is ambiguous/.test(m)) return ' Hint: more than one dataset in the query has that column — write it with the alias, e.g. a.agent_id.';
  if (/must appear in the group by clause|aggregate function/.test(m)) return ' Hint: every selected column must be inside an aggregate or listed in GROUP BY. Aggregate each dataset in its own CTE, then join the CTEs.';
  if (/division by zero/.test(m)) return ' Hint: divide by nullif(x, 0), so nothing to divide by gives null.';
  if (/operator does not exist|invalid input syntax|cannot be matched|function .* does not exist/.test(m)) {
    return ' Hint: the two sides have different types — cast one (::text, ::numeric, ::date, ::timestamptz), or check the function\'s arguments.';
  }
  if (/more than one row returned by a subquery/.test(m)) return ' Hint: a subquery used as a value returned several rows — aggregate it, or join it as a CTE instead.';
  return '';
}

async function log(db: DbOrTx, actor: Actor, opts: OpenQueryOptions, query: string, outcome: 'ok' | 'rejected' | 'error' | 'too_slow' | 'capped', detail: string | null, ms?: number, rows?: number) {
  // A tile on an open dashboard runs every minute: only its failures are worth a row.
  if (opts.via === 'tile' && outcome === 'ok') return;
  try {
    await db.insert(aiQueryLog).values({ agencyId: actor.agencyId!, userId: actor.userId, via: opts.via, sql: query.slice(0, 12000), outcome, detail: detail?.slice(0, 500) ?? null, ms: ms ?? null, rows: rows ?? null });
  } catch (err) {
    console.error('[open-query] log failed', err instanceof Error ? err.message : err);
  }
}
