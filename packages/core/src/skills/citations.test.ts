import { describe, expect, it } from 'vitest';
import { appointmentStatusEnum, skillHandlerEnum, skillModelTierEnum, skillRunStatusEnum } from '@repo/db/schema';
import { checkCitedText, parseRankedLines } from './citations';
import { parseSkillMarkdown, SKILL_HANDLERS, SKILL_MODEL_TIERS, SKILL_RUN_STATUSES } from './skill-schema';

const records = [
  { ref: 'A1', text: 'Appraisal with Tom Smith' },
  { ref: 'C1', text: 'Next action for Ann Lee: call about the 3 bed in Pakenham' },
  { ref: 'T1', text: 'Tom Smith: Re: Offer — we can go to 905,000 if settlement is 60 days' },
];

describe('every AI claim cites the record it came from', () => {
  it('accepts sentences that each cite a real record', () => {
    expect(checkCitedText('Start with the appraisal with Tom [A1]. Ann is overdue for a call [C1].', records)).toEqual({ ok: true, cited: ['A1', 'C1'] });
  });

  it('refuses an uncited sentence, an invented record, and a question', () => {
    expect(checkCitedText('You have a busy day. Tom first [A1].', records).ok).toBe(false);
    expect(checkCitedText('Call Bob [Z9].', records).ok).toBe(false);
    expect(checkCitedText('Will you call Ann [C1]?', records).ok).toBe(false);
  });

  it('lets a number through only when it is quoted from the record it cites', () => {
    expect(checkCitedText('Tom offered 905,000 if settlement is 60 days [T1].', records).ok).toBe(true);
    // The same figure, citing a record that does not contain it: rejected.
    expect(checkCitedText('Tom offered 905,000 [A1].', records).ok).toBe(false);
    // A computed figure: rejected.
    expect(checkCitedText('That is 10,000 more than asked [T1].', records).ok).toBe(false);
    expect(checkCitedText('You have 3 things to do today [A1].', records).ok).toBe(false);
  });
});

describe('a ranked list', () => {
  it('keeps real, unique records and drops the rest', () => {
    const { items, dropped } = parseRankedLines('T1 | A firm offer is waiting\nZ4 | invented\nT1 | duplicate\nnonsense', records);
    expect(items).toEqual([{ ref: 'T1', reason: 'A firm offer is waiting' }]);
    expect(dropped).toBe(3);
  });

  it('keeps the item but drops a reason that invents a figure', () => {
    const { items } = parseRankedLines('T1 | Worth 50,000 more than the last offer', records);
    expect(items).toEqual([{ ref: 'T1', reason: null }]);
  });
});

describe('skill Markdown', () => {
  it('reads requires, model and schedule from the front-matter', () => {
    const p = parseSkillMarkdown('---\nrequires: [google_calendar, zoom]\nmodel: summary\nschedule: weekly mon 07:30\n---\nDo the thing.');
    expect(p.requires).toEqual(['google_calendar', 'zoom']);
    expect(p.model).toBe('summary');
    expect(p.schedule).toEqual({ cadence: 'weekly', sendAtMinute: 450, sendOnWeekday: 1 });
    expect(p.instructions).toBe('Do the thing.');
    expect(p.errors).toEqual([]);
  });

  it('names what it cannot understand', () => {
    const p = parseSkillMarkdown('---\nrequires: [fax]\nmodel: genius\n---\n');
    expect(p.errors.join(' ')).toMatch(/fax/);
    expect(p.errors.join(' ')).toMatch(/model/);
    expect(p.errors.join(' ')).toMatch(/instructions/);
  });

  it('matches the database vocabularies', () => {
    expect([...SKILL_HANDLERS]).toEqual([...skillHandlerEnum.enumValues]);
    expect([...SKILL_MODEL_TIERS]).toEqual([...skillModelTierEnum.enumValues]);
    expect([...SKILL_RUN_STATUSES]).toEqual([...skillRunStatusEnum.enumValues]);
    expect(appointmentStatusEnum.enumValues.length).toBeGreaterThan(0);
  });
});
