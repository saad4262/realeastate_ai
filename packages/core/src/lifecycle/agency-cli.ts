import { assertNotProduction } from '@repo/db/production-guard';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDb } from '@repo/db';
import { closeAgency, deleteAgency, exportAgency } from './agency-closure';

/**
 * ADR 0093, by hand (an operator, never a page):
 *   tsx src/lifecycle/agency-cli.ts close  <agencyId> --by "<who asked>"
 *   tsx src/lifecycle/agency-cli.ts export <agencyId> <dir> [--files]
 *   tsx src/lifecycle/agency-cli.ts delete <agencyId> --confirm <slug>
 * Production needs CONFIRM_PRODUCTION (the database guard). Export before deleting.
 */
async function main() {
  const [cmd, agencyId, third] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  assertNotProduction(url);
  if (!url || !agencyId) throw new Error('Usage: close|export|delete <agencyId> … (DIRECT_URL must be set)');
  const db = getDb(url);
  if (cmd === 'close') {
    const by = flag('--by');
    if (!by) throw new Error('Say who asked: --by "<name, date>"');
    await closeAgency(db, agencyId, by);
    console.log('Closed (suspended). Export it now; deletion is allowed 30 days from today.');
  } else if (cmd === 'export') {
    if (!third) throw new Error('Give a directory to write to');
    await mkdir(third, { recursive: true, mode: 0o700 });
    const files = process.argv.includes('--files');
    const report = await exportAgency(db, agencyId, {
      rows: (table, rows) => writeFile(join(third, `${table}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n'), { mode: 0o600 }),
      ...(files
        ? {
            file: async (key, bytes) => {
              const to = join(third, 'files', key.replace(/\.\.+/g, '_'));
              await mkdir(dirname(to), { recursive: true, mode: 0o700 });
              await writeFile(to, bytes, { mode: 0o600 });
            },
          }
        : {}),
    });
    await writeFile(join(third, 'manifest.json'), JSON.stringify({ agencyId, at: new Date().toISOString(), ...report }, null, 2), { mode: 0o600 });
    console.log(`Exported ${Object.keys(report.tables).length} tables, ${Object.values(report.tables).reduce((a, b) => a + b, 0)} rows, ${report.files} files${report.filesFailed.length ? `; ${report.filesFailed.length} files FAILED (see manifest.json)` : ''}.`);
  } else if (cmd === 'delete') {
    const confirmSlug = flag('--confirm');
    if (!confirmSlug) throw new Error('Name the agency: --confirm <slug>');
    const r = await deleteAgency(db, agencyId, { confirmSlug });
    console.log(`Deleted. ${r.listingsArchived} listings archived, ${r.filesDeleted} files deleted${r.filesFailed.length ? `, ${r.filesFailed.length} files FAILED: re-run their deletes: ${r.filesFailed.join(', ')}` : ''}.`);
  } else {
    throw new Error('Command: close | export | delete');
  }
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
