import { describe, expect, it } from 'vitest';
import { parseSkillMarkdown, withInstructions } from '../skills/skill-schema';
import { ASSISTANT_TOOL_INPUTS, PLANNABLE_TOOLS, PROPOSED_ACTION_TOOLS } from './schema';
import { scheduleWords } from './skill-tools';

/** ADR 0041 Part A: skills from plain language — what holds without a database. */

describe('scheduleWords', () => {
  const base = { sendOnWeekday: null, intervalMinutes: null, timezone: 'Australia/Sydney' };
  it('says when, in the words the card shows', () => {
    expect(scheduleWords({ ...base, cadence: 'daily', sendAtMinute: 7 * 60 })).toBe('Every day at 7:00 am (Australia/Sydney)');
    expect(scheduleWords({ ...base, cadence: 'daily', sendAtMinute: 0 })).toBe('Every day at 12:00 am (Australia/Sydney)');
    expect(scheduleWords({ ...base, cadence: 'weekly', sendAtMinute: 17 * 60 + 30, sendOnWeekday: 1 })).toBe('Every Monday at 5:30 pm (Australia/Sydney)');
    expect(scheduleWords({ ...base, cadence: 'interval', sendAtMinute: 0, intervalMinutes: 120 })).toBe('Every 2 hours');
    expect(scheduleWords({ ...base, cadence: 'interval', sendAtMinute: 0, intervalMinutes: 45 })).toBe('Every 45 minutes');
  });
});

describe('withInstructions — new words, the same skill', () => {
  it('keeps the front-matter (what it needs, its model, its schedule) exactly and replaces only the text', () => {
    const md = '---\nrequires: [google_calendar]\nmodel: summary\nschedule: daily 07:00\n---\nOld words.\n';
    const out = withInstructions(md, '  Lead with today’s appointments.  ');
    const p = parseSkillMarkdown(out);
    expect(p.errors).toEqual([]);
    expect(p.requires).toEqual(['google_calendar']);
    expect(p.model).toBe('summary');
    expect(p.instructions).toBe('Lead with today’s appointments.');
    expect(out.startsWith('---\nrequires: [google_calendar]\nmodel: summary\nschedule: daily 07:00\n---\n')).toBe(true);
  });
  it('a skill with no front-matter is just the new text', () => {
    expect(withInstructions('Old words.', 'New words.')).toBe('New words.\n');
  });
  it('instructions that try to add front-matter stay instructions — they cannot add a requirement', () => {
    const out = withInstructions('---\nmodel: summary\n---\nOld.', '---\nrequires: [gmail]\n---\nSneaky');
    expect(parseSkillMarkdown(out).requires).toEqual([]);
  });
});

describe('the skill tools’ inputs', () => {
  it('a schedule is daily/weekly (with a day)/interval (with minutes), never anything else', () => {
    const p = (schedule: unknown) => ASSISTANT_TOOL_INPUTS.set_up_skill.safeParse({ skill: 'Q1', schedule }).success;
    expect(p({ cadence: 'daily', time: '07:00' })).toBe(true);
    expect(p({ cadence: 'weekly', time: '07:00' })).toBe(false);
    expect(p({ cadence: 'weekly', time: '07:00', weekday: 'mon' })).toBe(true);
    expect(p({ cadence: 'interval' })).toBe(false);
    expect(p({ cadence: 'interval', every_minutes: 5 })).toBe(false);
    expect(p({ cadence: 'interval', every_minutes: 120 })).toBe(true);
    expect(p({ cadence: 'daily', time: '7am' })).toBe(false);
  });
  it('are cards in the database CHECK, and not plan steps', () => {
    for (const t of ['set_up_skill', 'change_skill']) {
      expect(PROPOSED_ACTION_TOOLS as readonly string[]).toContain(t);
      expect(PLANNABLE_TOOLS as readonly string[]).not.toContain(t);
    }
  });
});
