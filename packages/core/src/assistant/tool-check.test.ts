import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_WRITE_TOOLS } from './schema';

/**
 * `proposed_action.tool` is a CHECK, so a tool the code can propose but the
 * database refuses fails only at the first real card. The newest migration
 * that sets the CHECK is the list the database has once migrated; the smoke
 * suite compares the live constraint the same way.
 */
const drizzleDir = join(__dirname, '../../../db/drizzle');

function newestToolCheck(): string[] {
  const files = readdirSync(drizzleDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  let list: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(drizzleDir, f), 'utf8');
    const m = src.match(/ADD CONSTRAINT "proposed_action_tool_check" CHECK \(tool IN \(([^)]*)\)\)/);
    if (m) list = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  }
  return list.sort();
}

describe('the proposed_action tool CHECK', () => {
  it('allows every write tool the code can propose — and nothing else', () => {
    expect(newestToolCheck()).toEqual([...ASSISTANT_WRITE_TOOLS].sort());
  });

  it('0039 adds lead assignment, the two template tools, delete/restore and the listings import — and keeps the rest', () => {
    expect(newestToolCheck()).toEqual(
      [
        'add_note', 'set_next_action', 'schedule_appointment', 'reschedule_appointment', 'cancel_appointment', 'send_template_email',
        'create_dashboard', 'assign_contacts', 'record_marketing_consent', 'withdraw_marketing_consent', 'update_contact', 'set_contact_archived',
        'assign_leads', 'send_new_template_email', 'save_email_template', 'delete_contact', 'restore_contact', 'import_listings',
      ].sort(),
    );
  });
});
