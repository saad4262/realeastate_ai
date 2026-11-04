import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '@repo/db';
import { readProposal, signProposal } from './signed';
import { checkAgentDraft, templateMessage } from '../agent-messages/check';
import { AgentMessageError, draftAgentMessage, sendGuideMessage } from '../agent-messages/message';
import { areaQuery, readSections, taskInputSchema, taskSummaryPasses, taskTemplateSummary, whenText } from '../tasks/sections';
import { buildTaskEmail } from '../tasks/run';
import { automationInputSchema, describeAutomation, sendableNow, ALLOWED, ACTIONS } from '../automation/rules';
import { AutomationError, automationLog, createAutomation, undoAutomationEvent } from '../automation/manage';
import { signAutomationSkillUnsubscribe, signAutomationUnsubscribe, verifyAutomationSkillUnsubscribe, verifyAutomationUnsubscribe } from '../automation/unsubscribe';
import { buildAutomationEmail } from '../automation/tick';
import { passesVerdictRule } from '../research/assist';

const SECRET = 'test-secret-test-secret';
const U = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const A = '7f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const sender = { from: { email: 'alerts@site.test', name: 'Property Platform' }, postalAddress: '1 Test St, Melbourne VIC 3000' };

describe('signed proposals (ADR 0080, C8 decision 12)', () => {
  it('round-trips, and refuses another kind, an edit, or an expired card', () => {
    const now = new Date('2026-11-04T00:00:00Z');
    const token = signProposal('task', { name: 'Monday', b: 1, a: 2 }, SECRET, { now });
    expect(readProposal('task', token, z.object({ name: z.string(), a: z.number(), b: z.number() }), SECRET, { now })).toEqual({ name: 'Monday', a: 2, b: 1 });
    expect(readProposal('automation', token.replace(/^task/, 'automation'), z.unknown(), SECRET, { now })).toBeNull();
    const [k, body, sig] = token.split('.');
    const forged = Buffer.from(Buffer.from(body!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').replace('Monday', 'Sunday')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(readProposal('task', `${k}.${forged}.${sig}`, z.unknown(), SECRET, { now })).toBeNull();
    expect(readProposal('task', token, z.unknown(), 'another-secret', { now })).toBeNull();
    expect(readProposal('task', token, z.unknown(), SECRET, { now: new Date('2026-11-12T00:00:00Z') })).toBeNull();
  });
});

describe('Agent AI: what a draft may say (decision 2)', () => {
  const sources = { buyerWords: 'Do the strata fees include building insurance? Can I see it Saturday? We need to settle before March.', listingFacts: ['Address: 12/1A Rogers Street, Pakenham VIC', 'Price: Offers over $690,000', 'Open home: Saturday 15 November at 10:15 am'] };
  const good = "Hi,\n\nI'm interested in 12/1A Rogers Street, Pakenham.\n\n1. Do the strata fees include the building insurance?\n2. Could I see the home again this Saturday? The listing shows an open home at 10:15 am.\n\nWe need to settle before March.\n\nThanks";
  it('keeps a draft made of the buyer’s words and the listing’s facts (a numbered list is layout)', () => {
    expect(checkAgentDraft(good, sources)).toEqual({ ok: true });
  });
  it('rejects an offer, a claim to act for the buyer, an invented figure, money they did not raise, and contact details', () => {
    expect(checkAgentDraft(`${good}\nWe'd be happy to offer $680,000.`, sources)).toMatchObject({ ok: false });
    expect(checkAgentDraft(`${good}\nI would pay the asking price.`, sources)).toMatchObject({ ok: false, reasons: expect.arrayContaining(['offer']) });
    expect(checkAgentDraft(`As Sam's buyer's agent, ${good}`, sources)).toMatchObject({ ok: false, reasons: expect.arrayContaining(['acts for the buyer']) });
    expect(checkAgentDraft(`${good}\nWe have 3 children.`, sources)).toMatchObject({ ok: false, reasons: expect.arrayContaining(['figure: 3']) });
    expect(checkAgentDraft(`${good}\nWe are pre-approved.`, sources)).toMatchObject({ ok: false, reasons: expect.arrayContaining(['money: pre-approved']) });
    expect(checkAgentDraft(`${good}\nCall me on 0412 884 920.`, sources)).toMatchObject({ ok: false, reasons: expect.arrayContaining(['contact details']) });
    expect(checkAgentDraft(`${good}\nsam@example.com`, sources)).toMatchObject({ ok: false });
  });
  it('allows money words the buyer used themselves', () => {
    expect(checkAgentDraft(`${good}\nWe have finance approval in place.`, { ...sources, buyerWords: `${sources.buyerWords} We have finance approval.` })).toEqual({ ok: true });
  });
  it('the template frames the buyer’s own words', () => {
    expect(templateMessage('5 Bay Court, Officer', 'Is there a pool?')).toBe("Hi,\n\nI'm interested in 5 Bay Court, Officer.\n\nIs there a pool?\n\nThanks");
  });
  it('refuses a visitor with no account before touching the database', async () => {
    await expect(draftAgentMessage({} as Db, { userId: '' }, { listingId: A, buyerWords: 'x', latest: 'x' }, { secret: SECRET })).rejects.toBeInstanceOf(AgentMessageError);
    await expect(sendGuideMessage({} as Db, { userId: '' }, { token: 'x', text: 'hello there' }, { secret: SECRET })).rejects.toBeInstanceOf(AgentMessageError);
  });
});

describe('Tasks: the contract (decisions 5–7)', () => {
  const base = { name: 'Monday in Pakenham', area: { suburb: 'Pakenham', state: 'VIC', priceTo: 800000, bedrooms: 3, propertyType: 'house' }, sections: ['new_homes', 'sold', 'price_reduced'], cadence: 'weekly', sendAtMinute: 420, sendOnWeekday: 1, timezone: 'Australia/Melbourne' };
  it('accepts up to four sections from the fixed list, and says when', () => {
    const t = taskInputSchema.parse(base);
    expect(t.skipEmpty).toBe(true);
    expect(t.area.channel).toBe('sale');
    expect(whenText(t)).toBe('Every Monday, 7:00 am');
    expect(areaQuery(t.area)).toEqual({ suburb: 'Pakenham', state: 'VIC', channel: 'sale', priceTo: 800000, bedrooms: 3, propertyType: 'house' });
  });
  it('refuses five sections, an unknown one, a repeat, a weekly with no day, and a suburb section with no suburb', () => {
    expect(taskInputSchema.safeParse({ ...base, sections: ['new_homes', 'sold', 'price_reduced', 'long_campaign', 'watched'] }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...base, sections: ['email_the_agent'] }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...base, sections: ['sold', 'sold'] }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...base, sendOnWeekday: undefined }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...base, area: { state: 'VIC' }, sections: ['sold'] }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...base, area: {}, sections: ['watched', 'open_homes'], cadence: 'once' }).success).toBe(true);
  });
  it('reads stored sections defensively', () => {
    expect(readSections(['sold', 'nonsense', 'watched'])).toEqual(['sold', 'watched']);
    expect(readSections(null)).toEqual([]);
  });
  it('the paragraph: no figure, no counting word, no verdict — else the template', () => {
    expect(taskSummaryPasses('This week in Pakenham there are new houses in your range and a recent sale.', passesVerdictRule)).toBe(true);
    for (const bad of ['There are 2 new homes.', 'Two new homes this week.', 'A couple of new homes.', 'Several sales and a bargain.', 'Prices will rise in Pakenham.', 'The best week yet.']) expect(taskSummaryPasses(bad, passesVerdictRule), bad).toBe(false);
    expect(taskTemplateSummary('Monday', false)).toBe('Nothing new for “Monday” since the last report.');
  });
  it('the email labels a model paragraph, renders every figure from the report, and carries the stop link', () => {
    const m = buildTaskEmail({ to: 'a@b.test', sender, baseUrl: 'https://site.test/', taskId: U, name: 'Monday', summary: 'New houses in your range.', summaryIsModel: true, report: { sections: [{ key: 'sold', title: 'What sold · 1', rows: [{ text: '17 Princes Highway, Pakenham', detail: 'Sold $655,000 · 12 Nov' }] }], hasNews: true, newListingIds: [] }, unsubscribeUrl: 'https://site.test/unsubscribe?t=x' });
    expect(m.text).toContain('Written by the property guide');
    expect(m.text).toContain('Sold $655,000 · 12 Nov');
    expect(m.listUnsubscribeUrl).toBe('https://site.test/unsubscribe?t=x');
    expect(buildTaskEmail({ ...{ to: 'a@b.test', sender, baseUrl: 'https://site.test', taskId: U, name: 'M', summary: 'Your report “M” is below.', summaryIsModel: false, report: { sections: [], hasNews: true, newListingIds: [] }, unsubscribeUrl: 'u' } }).text).not.toContain('Written by');
  });
});

describe('Automation: the fixed lists stop at the buyer’s own account (decisions 8–9)', () => {
  it('no action reaches an agency', () => {
    expect([...ACTIONS]).toEqual(['tell', 'shortlist_add', 'shortlist_remove']);
    for (const a of Object.values(ALLOWED).flatMap((x) => x.actions)) expect(['tell', 'shortlist_add', 'shortlist_remove']).toContain(a);
  });
  it('accepts a fitting rule and refuses one that does not fit', () => {
    expect(automationInputSchema.safeParse({ trigger: 'price_reduced', scope: 'shortlist', action: 'tell' }).success).toBe(true);
    expect(automationInputSchema.safeParse({ trigger: 'sold', scope: 'both', action: 'shortlist_remove', delivery: 'instant', timeZone: 'Australia/Perth' }).success).toBe(true);
    expect(automationInputSchema.safeParse({ trigger: 'price_reduced', scope: 'shortlist', action: 'shortlist_remove' }).success).toBe(false);
    expect(automationInputSchema.safeParse({ trigger: 'new_match', scope: 'search', action: 'shortlist_add' }).success).toBe(false); // no saved search named
    expect(automationInputSchema.safeParse({ trigger: 'new_match', scope: 'search', searchId: U, action: 'shortlist_add' }).success).toBe(true);
    expect(automationInputSchema.safeParse({ trigger: 'listed', scope: 'shortlist', action: 'tell' }).success).toBe(false);
    expect(automationInputSchema.safeParse({ trigger: 'price_reduced', scope: 'shortlist', action: 'enquire' }).success).toBe(false);
    expect(automationInputSchema.safeParse({ trigger: 'price_reduced', scope: 'shortlist', action: 'tell', timeZone: 'Mars/Olympus' }).success).toBe(false);
  });
  it('says what it does in words', () => {
    expect(describeAutomation({ trigger: 'price_reduced', scope: 'shortlist', action: 'tell', delivery: 'daily' })).toEqual({ when: 'When a home on my shortlist has its price reduced', then: 'Tell me · once a day at 8 am' });
    expect(describeAutomation({ trigger: 'new_match', scope: 'search', action: 'shortlist_add', delivery: 'instant' }, '3 bed in Pakenham').when).toBe('When a new home matches “3 bed in Pakenham”');
  });
  it('emails at 8 am for daily, and never 9 pm–7 am for instant (decision 10)', () => {
    const at = (hhmm: string) => new Date(`2026-11-04T${hhmm}:00+11:00`); // Melbourne daylight time
    expect(sendableNow('daily', at('08:10'), 'Australia/Melbourne')).toBe(true);
    expect(sendableNow('daily', at('09:10'), 'Australia/Melbourne')).toBe(false);
    expect(sendableNow('instant', at('14:00'), 'Australia/Melbourne')).toBe(true);
    expect(sendableNow('instant', at('21:30'), 'Australia/Melbourne')).toBe(false);
    expect(sendableNow('instant', at('06:59'), 'Australia/Melbourne')).toBe(false);
    expect(sendableNow('instant', at('07:00'), 'Australia/Melbourne')).toBe(true);
  });
  it('unsubscribe tokens: one automation, or the whole skill — never each other, never forged', () => {
    const one = signAutomationUnsubscribe(A, U, SECRET);
    expect(verifyAutomationUnsubscribe(one, SECRET)).toEqual({ ok: true, automationId: A, userId: U });
    expect(verifyAutomationSkillUnsubscribe(one, SECRET)).toEqual({ ok: false });
    expect(verifyAutomationUnsubscribe(one, 'other-secret')).toEqual({ ok: false });
    const all = signAutomationSkillUnsubscribe(U, SECRET);
    expect(verifyAutomationSkillUnsubscribe(all, SECRET)).toEqual({ ok: true, userId: U });
    expect(verifyAutomationUnsubscribe(all, SECRET)).toEqual({ ok: false });
  });
  it('the email names what each automation did and links to stop it', () => {
    const m = buildAutomationEmail({ to: 'a@b.test', sender, baseUrl: 'https://site.test', skillUnsubscribeUrl: 'https://site.test/unsubscribe?t=m', groups: [{ automationId: A, when: 'When a home on my shortlist sells or is leased', unsubscribeUrl: 'https://site.test/unsubscribe?t=a', lines: [{ address: '2/6 Henry Street, Pakenham', link: 'https://site.test/listing/x', text: 'Sold.', did: 'Taken off your shortlist.' }] }] });
    expect(m.subject).toBe('1 update from your automations');
    expect(m.text).toContain('2/6 Henry Street, Pakenham — Sold. Taken off your shortlist.');
    expect(m.text).toContain('Stop this automation: https://site.test/unsubscribe?t=a');
    expect(m.listUnsubscribeUrl).toBe('https://site.test/unsubscribe?t=m');
  });
  it('refuses a visitor with no account before touching the database', async () => {
    for (const call of [() => createAutomation({} as Db, { userId: '' }, {}), () => automationLog({} as Db, { userId: '' }), () => undoAutomationEvent({} as Db, { userId: '' }, U)]) await expect(call()).rejects.toBeInstanceOf(AutomationError);
  });
});
