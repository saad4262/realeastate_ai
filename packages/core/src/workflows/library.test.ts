import { describe, expect, it } from 'vitest';
import { DECIDABLE_TRIGGERS, TRIGGER_KINDS } from './catalog';
import { AUTOMATION_LIBRARY, LIBRARY_GROUPS, likeThisOn } from './library';

/** ADR 0068 (ROADMAP 4.3): the Automation Library — words for the card and for the assistant's box, never a spec. */

describe('the library', () => {
  it('has ten entries, each on a real trigger, in a group, with its own id', () => {
    expect(AUTOMATION_LIBRARY).toHaveLength(10);
    expect(new Set(AUTOMATION_LIBRARY.map((e) => e.id)).size).toBe(10);
    for (const e of AUTOMATION_LIBRARY) {
      expect(TRIGGER_KINDS).toContain(e.trigger);
      expect(LIBRARY_GROUPS).toContain(e.group);
      if (e.decides) expect(DECIDABLE_TRIGGERS).toContain(e.trigger);
    }
  });
  it('types words the assistant’s box takes whole, asking for what it needs, and always agency-wide', () => {
    for (const e of AUTOMATION_LIBRARY) {
      expect(e.ask.length).toBeLessThanOrEqual(1000);
      expect(e.ask).toMatch(/^Set up an agency-wide workflow: /);
      if (e.needs.includes('template')) expect(e.ask).toMatch(/Ask me which template/);
    }
  });
  it('counts the active workflows like an entry: same trigger, with or without a decision', () => {
    const reply = AUTOMATION_LIBRARY.find((e) => e.id === 'reply-enquiries')!;
    const sort = AUTOMATION_LIBRARY.find((e) => e.id === 'sort-enquiries')!;
    const wfs = [
      { status: 'active', triggerKind: 'lead.created' as const, decides: false },
      { status: 'paused', triggerKind: 'lead.created' as const, decides: false },
      { status: 'active', triggerKind: 'lead.created' as const, decides: true },
      { status: 'active', triggerKind: null, decides: false },
    ];
    expect(likeThisOn(reply, wfs)).toBe(1);
    expect(likeThisOn(sort, wfs)).toBe(1);
  });
});
