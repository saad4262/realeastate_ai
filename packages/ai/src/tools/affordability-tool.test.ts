import { describe, expect, it } from 'vitest';
import { PROPERTY_CHAT_V10 } from '../prompts/v10';
import { PROMPT_VERSION, PROPERTY_CHAT_V11 } from '../prompts/v11';
import { affordabilityInput, runAffordability } from './affordability-tool';
import { dispatchTool, type ToolContext } from './index';

const ctx = (blocks: ToolContext['skillBlocks'] = new Map()): ToolContext =>
  ({ places: new Map(), skillBlocks: blocks, scheduling: { state: 'signed_out' } }) as unknown as ToolContext;

describe('affordability_estimate (ADR 0080, C1)', () => {
  it('hands the model the duty as text to copy, with the source and the line to end on', () => {
    const out = runAffordability({ state: 'QLD', price: 750_000, buyer: 'first' });
    expect(out.result).toMatchObject({ price: '$750,000', stampDuty: { amount: '$10,925', atGeneralRate: '$26,775', saving: '$15,850', rates: 'first home concession', approximate: false }, repayments: null });
    expect(JSON.stringify(out.result)).toMatch(/Queensland Revenue Office/);
    expect(JSON.stringify(out.result)).toMatch(/not financial or credit advice/);
  });

  it('repayments only when the visitor gave both a deposit and a rate', () => {
    expect(runAffordability({ state: 'QLD', price: 750_000, buyer: 'first', deposit: 150_000 }).result).toMatchObject({ repayments: null });
    const out = runAffordability({ state: 'QLD', price: 750_000, buyer: 'first', deposit: 150_000, ratePct: 6.1 });
    expect(out.result).toMatchObject({ repayments: { loan: '$600,000', monthlyPrincipalAndInterest: '$3,635.97', monthlyInterestOnly: '$3,050', ifRatesRise: [{ rate: '7.1%', monthly: '$4,032.19' }, { rate: '8.1%', monthly: '$4,444.49' }], lmiMayApply: false } });
  });

  it('a state we have not verified: no figure, and the model is told to say so', () => {
    const out = runAffordability({ state: 'NT', price: 600_000, buyer: 'home' });
    expect(out.result).toMatchObject({ stampDuty: { amount: null } });
    expect(JSON.stringify(out.result)).toMatch(/give no figure/);
  });

  it('takes no income, savings or expenses: they are stripped before anything reads them', () => {
    const parsed = affordabilityInput.parse({ state: 'VIC', price: 700_000, buyer: 'home', income: 150_000, takeHomeMonthly: 9_000 });
    expect(Object.keys(parsed)).not.toContain('income');
    expect(Object.keys(parsed)).not.toContain('takeHomeMonthly');
  });

  it('is behind the Affordability AI switch', async () => {
    const out = await dispatchTool('affordability_estimate', { state: 'QLD', price: 750_000, buyer: 'first' }, ctx(new Map([['affordability', 'switched_off']])));
    expect(JSON.stringify(out.result)).toMatch(/switched off in your Skills/);
    const on = await dispatchTool('affordability_estimate', { state: 'QLD', price: 750_000, buyer: 'first' }, ctx());
    expect(on.result).toMatchObject({ stampDuty: { amount: '$10,925' } });
  });

  it('prompt v11 is v10 plus the tool and its rules', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v11');
    expect(PROPERTY_CHAT_V11).toContain('You have eight tools.');
    expect(PROPERTY_CHAT_V11).not.toContain('You have seven tools.');
    expect(PROPERTY_CHAT_V11.startsWith(PROPERTY_CHAT_V10.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V11).toMatch(/Never assume an interest rate/);
    expect(PROPERTY_CHAT_V11).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/); // #5: nothing volatile in the system prompt
  });
});
