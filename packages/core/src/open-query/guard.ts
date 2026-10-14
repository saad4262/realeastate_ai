import { parse } from 'libpg-query';

/**
 * L1 of ADR 0042: the parser. A model-written query is parsed by the real Postgres
 * parser and accepted only if EVERY node in it is a kind this file allows, every table
 * it names is a named dataset (or a CTE it defines itself), and every function is on
 * the allowlist. Anything the parser cannot read is refused. This is the first of
 * four locks, not the only one: the views (L4) and the role (L3) hold even if this
 * file is wrong — which is exactly what the smoke suite tests by switching it off.
 */

export const QUERY_MAX_CHARS = 4000;

/** Node kinds a read query is made of. Anything else — a write, a lock, a parameter, XMLTABLE, TABLESAMPLE — is refused. */
const NODES = new Set([
  'SelectStmt', 'ResTarget', 'ColumnRef', 'String', 'A_Const', 'Integer', 'Float', 'Boolean', 'A_Star',
  'FuncCall', 'TypeCast', 'TypeName', 'A_Expr', 'BoolExpr', 'NullTest', 'BooleanTest', 'CaseExpr', 'CaseWhen',
  'CoalesceExpr', 'MinMaxExpr', 'SubLink', 'RangeVar', 'RangeSubselect', 'RangeFunction', 'JoinExpr', 'Alias',
  'SortBy', 'WindowDef', 'WithClause', 'CommonTableExpr', 'List', 'A_ArrayExpr', 'A_Indirection', 'A_Indices',
  'RowExpr', 'SQLValueFunction', 'GroupingSet', 'CollateClause',
]);

/** Functions a figure may use: aggregates, windows, dates, maths, text, arrays. Nothing with a side effect or a view of the server. */
export const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  'count', 'sum', 'avg', 'min', 'max', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
  'percentile_cont', 'percentile_disc', 'mode', 'array_agg', 'string_agg', 'bool_and', 'bool_or', 'every', 'corr',
  // windows
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value',
  // dates and times
  'now', 'date_trunc', 'date_part', 'extract', 'age', 'to_char', 'to_date', 'to_timestamp', 'make_date', 'make_interval',
  'make_timestamp', 'make_timestamptz', 'date_bin', 'timezone', 'justify_days', 'justify_hours', 'justify_interval', 'isfinite',
  'generate_series', 'overlaps',
  // maths
  'round', 'floor', 'ceil', 'ceiling', 'abs', 'trunc', 'mod', 'power', 'sqrt', 'sign', 'div', 'width_bucket', 'greatest', 'least',
  'to_number',
  // text
  'lower', 'upper', 'initcap', 'length', 'char_length', 'character_length', 'trim', 'btrim', 'ltrim', 'rtrim', 'substr',
  'substring', 'left', 'right', 'concat', 'concat_ws', 'replace', 'split_part', 'position', 'strpos', 'lpad', 'rpad',
  'starts_with', 'format', 'regexp_replace', 'regexp_match', 'regexp_like', 'translate', 'like_escape', 'nullif',
  // arrays
  'array_length', 'cardinality', 'unnest', 'array_to_string', 'array_position', 'array_remove', 'array_append', 'array_cat',
]);

/** Casts a query may make: plain values only (a `regclass` or `regproc` cast would look into the catalog). */
const ALLOWED_TYPES = new Set([
  'int2', 'int4', 'int8', 'smallint', 'integer', 'int', 'bigint', 'numeric', 'decimal', 'float4', 'float8', 'real',
  'double precision', 'text', 'varchar', 'bpchar', 'char', 'bool', 'boolean', 'date', 'time', 'timetz', 'timestamp',
  'timestamptz', 'interval', 'uuid',
]);

/** `current_date` and friends; never `current_user`, `session_user`, `current_schema` … */
const ALLOWED_VALUE_FUNCTIONS = new Set([
  'SVFOP_CURRENT_DATE', 'SVFOP_CURRENT_TIME', 'SVFOP_CURRENT_TIME_N', 'SVFOP_CURRENT_TIMESTAMP', 'SVFOP_CURRENT_TIMESTAMP_N',
  'SVFOP_LOCALTIME', 'SVFOP_LOCALTIME_N', 'SVFOP_LOCALTIMESTAMP', 'SVFOP_LOCALTIMESTAMP_N',
]);

export type GuardResult = { ok: true; datasets: string[] } | { ok: false; problem: string };

type Node = Record<string, unknown>;

const strings = (list: unknown): string[] =>
  Array.isArray(list) ? list.map((n) => ((n as { String?: { sval?: string } }).String?.sval ?? '').toLowerCase()) : [];

/**
 * Check one query against the named datasets. `datasets` are the names the model may
 * read; `reserved` are names it may not define for itself (the views' own names, so a
 * CTE can never stand in for one).
 */
export async function checkQuery(text: string, datasets: readonly string[], reserved: readonly string[] = []): Promise<GuardResult> {
  const trimmed = text.trim().replace(/;\s*$/, '');
  if (!trimmed) return { ok: false, problem: 'The query is empty.' };
  if (trimmed.length > QUERY_MAX_CHARS) return { ok: false, problem: `The query is longer than ${QUERY_MAX_CHARS} characters. Make it simpler.` };
  let tree: { stmts?: { stmt?: Node }[] };
  try {
    tree = (await parse(trimmed)) as typeof tree;
  } catch (err) {
    return { ok: false, problem: `Postgres could not read the query: ${err instanceof Error ? err.message : 'syntax error'}.` };
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) return { ok: false, problem: 'Exactly one statement, please — a single SELECT.' };
  const top = stmts[0]!.stmt ?? {};
  if (!('SelectStmt' in top)) return { ok: false, problem: 'Only a SELECT may run. Nothing that changes data is ever allowed.' };

  const known = new Set(datasets.map((d) => d.toLowerCase()));
  const forbiddenNames = new Set([...known, ...reserved.map((r) => r.toLowerCase())]);
  const own = new Set<string>();
  const used = new Set<string>();
  const problems: string[] = [];

  // First pass: the CTEs the query defines for itself.
  const collectCtes = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(collectCtes);
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v as Node)) {
      if (k === 'CommonTableExpr') {
        const name = String((child as { ctename?: string }).ctename ?? '').toLowerCase();
        if (forbiddenNames.has(name)) problems.push(`"${name}" is a dataset's name; give your own CTE another name.`);
        own.add(name);
      }
      collectCtes(child);
    }
  };
  collectCtes(top);

  const typeProblem = (names: unknown) => {
    const parts = strings(names);
    if (!parts.length) return;
    const name = parts[parts.length - 1] ?? '';
    const schemaOk = parts.length === 1 || (parts.length === 2 && parts[0] === 'pg_catalog');
    if (!schemaOk || !ALLOWED_TYPES.has(name)) problems.push(`A cast to "${parts.join('.')}" is not allowed.`);
  };

  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v as Node)) {
      if (/^[A-Z]/.test(k)) {
        if (!NODES.has(k)) {
          problems.push(nodeProblem(k));
          continue;
        }
        const node = (child ?? {}) as Node;
        switch (k) {
          // Some children come UNWRAPPED (a field holding the node itself, not `{ Kind: … }`): the
          // WITH clause, a cast's type, an operator's name. They are checked here, on their parent.
          case 'SelectStmt':
            if (node.intoClause) problems.push('SELECT … INTO is not allowed.');
            if (node.lockingClause) problems.push('FOR UPDATE / FOR SHARE is not allowed.');
            if ((node.withClause as Node | undefined)?.recursive) problems.push('WITH RECURSIVE is not allowed; use generate_series for a series.');
            break;
          case 'WithClause':
            if (node.recursive) problems.push('WITH RECURSIVE is not allowed; use generate_series for a series.');
            break;
          case 'TypeCast':
            typeProblem((node.typeName as Node | undefined)?.names);
            break;
          case 'A_Expr': {
            const op = strings(node.name);
            if (op.length > 1 && op[0] !== 'pg_catalog') problems.push(`The operator "${op.join('.')}" is not allowed.`);
            break;
          }
          case 'RangeVar': {
            const name = String(node.relname ?? '').toLowerCase();
            if (node.schemaname || node.catalogname) problems.push(`"${node.schemaname}.${name}": name a dataset without a schema.`);
            else if (known.has(name)) used.add(name);
            else if (!own.has(name)) problems.push(`"${name}" is not a dataset. The datasets are: ${datasets.join(', ')}.`);
            break;
          }
          case 'FuncCall': {
            const parts = strings(node.funcname);
            const name = parts[parts.length - 1] ?? '';
            const schemaOk = parts.length === 1 || (parts.length === 2 && parts[0] === 'pg_catalog');
            if (!schemaOk || !ALLOWED_FUNCTIONS.has(name)) problems.push(`The function "${parts.join('.')}" is not allowed.`);
            break;
          }
          case 'TypeName':
            typeProblem(node.names);
            break;
          case 'SQLValueFunction':
            if (!ALLOWED_VALUE_FUNCTIONS.has(String(node.op))) problems.push('Only current_date / current_timestamp / localtimestamp are allowed there.');
            break;
        }
      }
      walk(child);
    }
  };
  walk(top);

  if (problems.length) return { ok: false, problem: [...new Set(problems)].slice(0, 5).join(' ') };
  if (!used.size) return { ok: false, problem: `The query reads no dataset. The datasets are: ${datasets.join(', ')}.` };
  return { ok: true, datasets: [...used] };
}

function nodeProblem(kind: string): string {
  if (/Stmt$/.test(kind)) return 'Only a SELECT may run. Nothing that changes data is ever allowed.';
  if (kind === 'ParamRef') return 'Parameters ($1) are not allowed; write the value.';
  if (kind === 'LockingClause') return 'FOR UPDATE / FOR SHARE is not allowed.';
  if (kind === 'IntoClause') return 'SELECT … INTO is not allowed.';
  if (kind === 'RangeTableSample') return 'TABLESAMPLE is not allowed.';
  return `"${kind}" is not allowed in a query here.`;
}
