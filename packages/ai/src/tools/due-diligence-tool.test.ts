import { describe, expect, it } from 'vitest';
import { PROPERTY_CHAT_V11 } from '../prompts/v11';
import { PROMPT_VERSION, PROPERTY_CHAT_V12 } from '../prompts/v12';
import { dispatchTool, type ToolContext } from './index';

const facts = [
  { ref: 'R1', when: 'Now', text: 'For sale since 23 Sept 2026 — 41 days on the market. Offers over $720,000.' },
  { ref: 'R2', when: '14 Mar 2019', text: 'Sold for $455,000.' },
];
const ID = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    places: new Map(),
    skillBlocks: new Map(),
    scheduling: { state: 'signed_out' },
    dueDiligence: async (id: string) => (id === ID ? { address: '8 Example Court, Springfield Lakes', state: 'QLD', facts } : null),
    ...over,
  }) as unknown as ToolContext;

describe('due_diligence (ADR 0080, C2)', () => {
  it('hands the model the records with their references, the state checklist with its source, and the legal line', async () => {
    const out = await dispatchTool('due_diligence', { listingId: ID }, ctx());
    expect(out.result).toMatchObject({ found: true, state: 'QLD', records: ['[R1] Now: For sale since 23 Sept 2026 — 41 days on the market. Offers over $720,000.', '[R2] 14 Mar 2019: Sold for $455,000.'], stateNotVerified: null });
    const r = out.result as { stateChecklist: string[]; stateChecklistSource: string; instruction: string };
    expect(r.stateChecklist[0]).toMatch(/seller disclosure statement \(Form 2\)/);
    expect(r.stateChecklistSource).toMatch(/Queensland Government/);
    expect(r.instruction).toMatch(/not legal advice/);
  });

  it('an unknown or non-public listing: found false, nothing invented', async () => {
    const out = await dispatchTool('due_diligence', { listingId: '00000000-0000-4000-8000-000000000000' }, ctx());
    expect(out.result).toMatchObject({ found: false });
  });

  it('a state we have not verified says so', async () => {
    const out = await dispatchTool('due_diligence', { listingId: ID }, ctx({ dueDiligence: async () => ({ address: 'x', state: 'NT', facts }) }));
    expect(out.result).toMatchObject({ stateChecklist: null });
    expect(JSON.stringify(out.result)).toMatch(/not verified NT/);
  });

  it('is behind the Due-Diligence AI switch', async () => {
    const out = await dispatchTool('due_diligence', { listingId: ID }, ctx({ skillBlocks: new Map([['due_diligence', 'switched_off']]) }));
    expect(JSON.stringify(out.result)).toMatch(/switched off in your Skills/);
  });

  it('prompt v12 is v11 plus the tool and its rules', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v12');
    expect(PROPERTY_CHAT_V12).toContain('You have nine tools.');
    expect(PROPERTY_CHAT_V12).not.toContain('You have eight tools.');
    expect(PROPERTY_CHAT_V12.startsWith(PROPERTY_CHAT_V11.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V12).toMatch(/never value the home/);
    expect(PROPERTY_CHAT_V12).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
  });
});
