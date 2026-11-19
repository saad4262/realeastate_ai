import { describe, expect, it } from 'vitest';
import { unclassified, type Catalog } from './agency-closure';

/** ADR 0093. Export and deletion run end to end in the smoke group "Agency closure". */
describe('unclassified: a new table or secret column stops the export until someone decides', () => {
  const base: Catalog = { direct: ['contact', 'agent_invite'], children: [{ table: 'contact_role', parent: 'contact', column: 'contact_id' }], secretColumns: [{ table: 'agent_invite', column: 'token' }] };
  it('the known lists cover it', () => {
    expect(unclassified(base)).toEqual([]);
  });
  it('a child table nobody classified', () => {
    expect(unclassified({ ...base, children: [...base.children, { table: 'new_child', parent: 'contact', column: 'contact_id' }] })).toEqual(['child table new_child (of contact) is neither exported nor excluded']);
  });
  it('a secret-looking column that is not redacted (an excluded table needs none)', () => {
    expect(unclassified({ ...base, secretColumns: [{ table: 'contact', column: 'api_secret' }, { table: 'job', column: 'refresh_token' }] })).toEqual(['contact.api_secret looks secret and is not redacted']);
  });
});
