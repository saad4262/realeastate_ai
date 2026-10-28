import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { specInWords, specProblem, workflowSpecSchema } from './catalog';
import { decideRun, pickChoice, stepsOfChoice, type WorkflowDecider } from './decide';
import { specFrom } from '../assistant/workflow-tools';

/** ADR 0067 (ROADMAP 4.2): "AI decides" — one of the person's labels, or "Not sure". */

const remind = (text: string) => ({ type: 'remind_owner', text });
const base = {
  trigger: { kind: 'lead.created', source: 'website' },
  actions: [remind('Read it — the AI could not tell')],
  decide: {
    question: 'Do they want to sell, buy or rent?',
    choices: [
      { label: 'Sell', actions: [{ type: 'assign_lead', to: '11111111-1111-4111-8111-111111111111' }, remind('Book the appraisal')] },
      { label: 'Buy', actions: [remind('Call them')] },
    ],
  },
};
const spec = (over: Record<string, unknown> = {}) => workflowSpecSchema.parse({ ...base, ...over });

describe('the decision in the catalog', () => {
  it('parses, and says itself in words with "Not sure" as the workflow’s own steps', () => {
    const w = specInWords(spec());
    expect(w.decide?.question).toBe('Do they want to sell, buy or rent?');
    expect(w.decide?.choices.map((c) => c.label)).toEqual(['Sell', 'Buy']);
    expect(w.then).toEqual(['Remind you: “Read it — the AI could not tell”']);
  });
  it('is only for triggers with words to read', () => {
    expect(specProblem(spec(), 'agency')).toBeNull();
    expect(specProblem(spec({ trigger: { kind: 'appointment.completed' }, decide: { ...base.decide, choices: [{ label: 'Keen', actions: [remind('a')] }, { label: 'Not keen', actions: [remind('b')] }] } }), 'agency')).toBeNull();
    expect(specProblem(spec({ trigger: { kind: 'listing.status_changed', to: 'live' } }), 'agency')).toMatch(/only decide/);
  });
  it('needs labels of their own, never "Not sure", and 2 to 4 of them', () => {
    expect(specProblem(spec({ decide: { ...base.decide, choices: [{ label: 'Sell', actions: [remind('a')] }, { label: 'sell', actions: [remind('b')] }] } }), 'agency')).toMatch(/own label/);
    expect(specProblem(spec({ decide: { ...base.decide, choices: [{ label: 'Sell', actions: [remind('a')] }, { label: 'not sure', actions: [remind('b')] }] } }), 'agency')).toMatch(/Not sure/);
    expect(() => spec({ decide: { ...base.decide, choices: [{ label: 'Sell', actions: [remind('a')] }] } })).toThrow();
  });
  it('checks every choice’s steps like the workflow’s own, naming the choice', () => {
    expect(specProblem(spec(), 'mine')).toMatch(/^Sell: Action 1 \(give the lead to\): only an agency-wide workflow/);
    expect(specProblem(spec({ decide: { ...base.decide, choices: [{ label: 'Sell', actions: [remind('a'), { type: 'wait', hours: 2 }] }, base.decide.choices[1]] } }), 'agency')).toMatch(/^Sell: A workflow cannot end with a wait/);
  });
});

describe('the AI’s answer', () => {
  it('counts only as one of the labels', () => {
    expect(pickChoice(' sell ', ['Sell', 'Buy'])).toBe('Sell');
    expect(pickChoice('Rent', ['Sell', 'Buy'])).toBeNull();
    expect(pickChoice(null, ['Sell', 'Buy'])).toBeNull();
  });
  it('runs that choice’s steps, or the workflow’s own when not sure', () => {
    expect(stepsOfChoice(spec(), 'Buy')).toEqual([{ type: 'remind_owner', text: 'Call them', mail_me: false }]);
    expect(stepsOfChoice(spec(), null)).toEqual([{ type: 'remind_owner', text: 'Read it — the AI could not tell', mail_me: false }]);
  });
});

describe('asking — never failing the run', () => {
  const owner: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'owner' };
  const facts = { agencyId: 'a1', leadId: 'l1', appointmentId: null };
  /** Switch rows from `select`, words and budget rows from `execute`. */
  const fakeDb = (o: { switchOff?: boolean; text?: string | null; spent?: number }) =>
    ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (o.switchOff ? [{ enabled: false }] : []) }) }) }),
      execute: async (q: { queryChunks?: unknown[] }) => {
        const s = JSON.stringify(q.queryChunks ?? '');
        if (s.includes('ai_run')) return [{ agency: String(o.spent ?? 0), total: '0' }];
        return [{ message: o.text ?? null, mail: null, subject: null }];
      },
    }) as unknown as Db;
  const decider = (answer: { choice: string | null; reason: string } | Error): WorkflowDecider => async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const d = spec().decide!;
  it('is "Not sure" with why: no AI on the server, the switch off, nothing to read, the budget spent, or a failure', async () => {
    expect(await decideRun(fakeDb({ text: 'x' }), owner, d, facts, null)).toMatchObject({ choice: null, by: 'unavailable' });
    expect(await decideRun(fakeDb({ switchOff: true, text: 'x' }), owner, d, facts, decider({ choice: 'Sell', reason: '' }))).toMatchObject({ choice: null, by: 'off' });
    expect(await decideRun(fakeDb({ text: null }), owner, d, facts, decider({ choice: 'Sell', reason: '' }))).toMatchObject({ choice: null, by: 'no_text' });
    expect(await decideRun(fakeDb({ text: 'We want to sell', spent: 5 }), owner, d, facts, decider({ choice: 'Sell', reason: '' }), { env: {} as NodeJS.ProcessEnv })).toMatchObject({ choice: null, by: 'budget' });
    expect(await decideRun(fakeDb({ text: 'We want to sell' }), owner, d, facts, decider(new Error('network')), { env: {} as NodeJS.ProcessEnv })).toMatchObject({ choice: null, by: 'failed' });
  });
  it('keeps the AI’s label and why — and a label it made up is "Not sure"', async () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(await decideRun(fakeDb({ text: 'We want to sell our 3-bed' }), owner, d, facts, decider({ choice: 'sell', reason: 'They say they want to sell.' }), { env })).toEqual({ choice: 'Sell', reason: 'They say they want to sell.', by: 'ai' });
    expect(await decideRun(fakeDb({ text: 'Rent please' }), owner, d, facts, decider({ choice: 'Rent', reason: 'Wants to rent.' }), { env })).toMatchObject({ choice: null, by: 'ai' });
  });
});

describe('the assistant’s parts', () => {
  it('build each choice’s steps, references resolved, and name a broken one', () => {
    const ctx = { handles: new Map() } as never;
    const input = {
      name: 'Sort', scope: 'agency' as const, trigger: { kind: 'lead.created' as const }, conditions: [],
      actions: [{ type: 'remind_owner' as const, text: 'Read it' }],
      decide: { question: 'Sell or buy?', choices: [{ label: 'Sell', actions: [{ type: 'remind_owner' as const, text: 'Appraisal' }] }, { label: 'Buy', actions: [{ type: 'assign_lead' as const }] }] },
    };
    expect(specFrom(ctx, input as never)).toEqual({ problem: expect.stringContaining('choice “Buy”, action 1 (assign_lead) needs member') });
    const ok = specFrom(ctx, { ...input, decide: { ...input.decide, choices: [input.decide.choices[0]!, { label: 'Buy', actions: [{ type: 'remind_owner' as const, text: 'Call' }] }] } } as never);
    expect(ok).toMatchObject({ spec: { decide: { question: 'Sell or buy?', choices: [{ label: 'Sell' }, { label: 'Buy' }] } } });
  });
});
