import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * In a select with NO join, Drizzle (0.38) renders a column in the select list
 * without its table: `${teamThread.id}` becomes a bare "id". Inside a
 * correlated subquery that name binds to the INNER table when it has a column
 * of that name — `where p.thread_id = "id"` compared against "user".id, and
 * every team conversation answered "not found" (found 2026-10-12; the skills
 * list's "my copy" had the same fault). WHERE and ORDER BY are qualified; the
 * select list is not.
 *
 * So: a subquery in the select list of a single-table select writes the outer
 * column out (`team_thread.id`) instead of interpolating it.
 */

const SRC = join(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const schema = readFileSync(join(SRC, '..', '..', 'db', 'src', 'schema.ts'), 'utf8');
const tables = new Set([...schema.matchAll(/export const (\w+) = pgTable/g)].map((m) => m[1]!));

/** Interpolations of a column INSIDE the subquery text: `${table.col}` with a known table. */
function columnRefs(body: string): string[] {
  return [...body.matchAll(/\$\{(\w+)\.(\w+)\}/g)].filter((m) => tables.has(m[1]!)).map((m) => `${m[1]}.${m[2]}`);
}

/**
 * Columns whose subquery has no table of its own with that column name are
 * harmless (e.g. `jsonb_array_elements(${row.photos}) p`); listed with why.
 */
const ALLOWED: Record<string, string> = {
  'imports/imports.ts listingImportRow.photos': 'the subquery reads jsonb_array_elements, which has no `photos` column',
};

describe('single-table selects: no interpolated outer column inside a select-list subquery', () => {
  it('writes the outer column out instead', () => {
    const problems: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/sql(?:<[^`]*?>)?`((?:[^`\\]|\\.)*)`/gs)) {
        const body = m[1]!;
        if (!/\bselect\b|\bexists\b/i.test(body)) continue;
        const refs = columnRefs(body);
        if (!refs.length) continue;
        const at = m.index!;
        const sel = src.lastIndexOf('.select(', at);
        if (sel < 0 || src.slice(sel, at).includes('.from(')) continue; // not in a select list
        const from = src.indexOf('.from(', at + m[0].length);
        if (from < 0) continue;
        const end = src.indexOf(';', from);
        if (/[jJ]oin\(/.test(src.slice(from, end < 0 ? undefined : end))) continue; // joined: Drizzle qualifies
        const rel = relative(SRC, file);
        for (const ref of new Set(refs)) {
          if (ALLOWED[`${rel} ${ref}`]) continue;
          problems.push(`${rel}:${src.slice(0, at).split('\n').length} \${${ref}} in a subquery of a single-table select`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
