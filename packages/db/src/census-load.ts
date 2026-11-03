import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb } from './client';
import { suburbCensus } from './schema';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Loads ABS Census 2021 housing figures per suburb into `suburb_census` (ADR 0080, C5 decision 3), from
 * data/census/abs-census-2021-sal.csv. Idempotent: an upsert by SAL code, so running it twice changes nothing.
 * The CSV is ours (built from the ABS DataPack by build-sal-2021.py); its cells are numbers or empty, nothing else.
 *
 *   pnpm --filter @repo/db db:census            # load
 *   pnpm --filter @repo/db db:census --dry-run  # parse and count, write nothing
 */

const FILE = resolve(process.cwd(), 'data/census/abs-census-2021-sal.csv');
const INT_COLUMNS = ['population', 'dwellings', 'separate_houses', 'semi_detached', 'flats', 'owned_outright', 'owned_mortgage', 'rented', 'tenure_total', 'median_rent_weekly', 'median_mortgage_monthly'] as const;
const STATES = new Set(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']);

/** A cell: an integer, or null when empty. Anything else stops the load — the file is ours and should never hold it. */
function int(v: string, where: string): number | null {
  if (v === '') return null;
  if (!/^\d+$/.test(v)) throw new Error(`Not a whole number at ${where}: ${JSON.stringify(v)}`);
  return Number(v);
}

export function parseCensusCsv(text: string) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head!.split(',');
  return lines.map((line, i) => {
    // Names may hold commas only inside quotes; the build script writes them with csv, so split carefully.
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    const row = Object.fromEntries(cols.map((c, j) => [c, cells[j] ?? ''])) as Record<string, string>;
    const where = `line ${i + 2}`;
    if (!/^SAL\d{5}$/.test(row.sal_code!)) throw new Error(`Bad SAL code at ${where}`);
    if (!STATES.has(row.state!)) throw new Error(`Bad state at ${where}`);
    const size = row.avg_household_size === '' ? null : row.avg_household_size!;
    if (size !== null && !/^\d+(\.\d+)?$/.test(size)) throw new Error(`Bad household size at ${where}`);
    const ints = Object.fromEntries(INT_COLUMNS.map((c) => [c, int(row[c] ?? '', `${where} ${c}`)])) as Record<(typeof INT_COLUMNS)[number], number | null>;
    return {
      salCode: row.sal_code!,
      censusYear: 2021,
      name: row.name!.trim(),
      nameKey: row.name!.trim().toLowerCase(),
      state: row.state!,
      population: ints.population,
      dwellings: ints.dwellings,
      separateHouses: ints.separate_houses,
      semiDetached: ints.semi_detached,
      flats: ints.flats,
      ownedOutright: ints.owned_outright,
      ownedMortgage: ints.owned_mortgage,
      rented: ints.rented,
      tenureTotal: ints.tenure_total,
      medianRentWeekly: ints.median_rent_weekly,
      medianMortgageMonthly: ints.median_mortgage_monthly,
      avgHouseholdSize: size,
    };
  });
}

async function main() {
  const rows = parseCensusCsv(readFileSync(FILE, 'utf8'));
  console.log(`[census] ${rows.length} suburbs parsed from ${FILE}`);
  if (process.argv.includes('--dry-run')) return;
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = getDb(url);
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await db
      .insert(suburbCensus)
      .values(batch)
      .onConflictDoUpdate({
        target: suburbCensus.salCode,
        set: Object.fromEntries(
          ['name', 'name_key', 'state', 'population', 'dwellings', 'separate_houses', 'semi_detached', 'flats', 'owned_outright', 'owned_mortgage', 'rented', 'tenure_total', 'median_rent_weekly', 'median_mortgage_monthly', 'avg_household_size', 'census_year'].map((c) => [c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase()), sql.raw(`excluded.${c}`)]),
        ),
      });
  }
  const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from suburb_census`)) as unknown as [{ n: number }];
  console.log(`[census] loaded; suburb_census now holds ${n} rows`);
  process.exit(0);
}

if (process.argv[1]?.endsWith('census-load.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
