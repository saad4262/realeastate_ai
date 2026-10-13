import { SPEC_RANGE_LABELS, type SpecRange } from './spec';
import { DATASET_IDS, DATASETS, TIME_UNITS, type DatasetDef } from './catalog';

/**
 * The catalog in plain words, for the assistant's system prompt (ADR 0036
 * Phase 3). Built from the catalog itself, so the model is told exactly the
 * ids core accepts. Deterministic and date-free (#5): the prompt that embeds
 * it stays byte-identical and cached. A change here changes the prompt — the
 * ai package's test pins its hash, so a catalog change also bumps the prompt
 * version.
 */
export function catalogForPrompt(): string {
  const lines: string[] = [];
  for (const id of DATASET_IDS) {
    const ds: DatasetDef = DATASETS[id];
    const when =
      ds.kind === 'snapshot'
        ? 'Snapshot: the state right now — no range, no time steps.'
        : `Event: the range applies (default ${SPEC_RANGE_LABELS[ds.defaultRange as SpecRange]}); time steps ${TIME_UNITS.join(', ')}.`;
    const who = ds.permission === 'report:read_agency' ? ' Owners and admins only.' : '';
    lines.push(`- ${id} — ${ds.about}. ${when}${who}`);
    lines.push(`  measures: ${Object.entries(ds.measures).map(([m, d]) => `${m} (${d.about})`).join('; ')}`);
    lines.push(
      `  dimensions: ${Object.entries(ds.dimensions)
        .map(([k, d]) => {
          const admin = d.permission === 'report:read_agency' ? ', owners/admins' : '';
          // A dimension with a list is shown by its values (the words a filter must use); a free one by what it is.
          return d.values ? `${k} [${d.values.join(' | ')}${admin}]` : `${k} (${d.about}${admin})`;
        })
        .join('; ')}`,
    );
  }
  return lines.join('\n');
}
