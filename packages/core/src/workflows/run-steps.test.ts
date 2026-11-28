import { describe, expect, it } from 'vitest';
import { stepAfterWords } from '../recurring/detail-types';
import { runSteps } from './manage';

/** ADR 0106 part 3: a run in the panel says who it is for, and each step's exact time — or, not yet due, how long after the one before. */

const DONE = new Date('2026-11-28T01:02:00Z');
const DUE = new Date('2026-11-28T03:02:00Z');
const card = (title: string, name = 'Sara Khan') => ({ title, contact: { id: 'c1', name }, lines: [], notes: [] });
const step = (over: object) => ({ card: card('Email'), args: {}, status: 'blocked', error: null, runAt: null, finishedAt: null, ...over });

describe('runSteps', () => {
  it('who: the name the steps were made with; null when none named anyone', () => {
    expect(runSteps([step({ card: card('Assign', '') }), step({})]).who).toBe('Sara Khan');
    expect(runSteps([step({ card: { title: 'Remind me' } })]).who).toBeNull();
    expect(runSteps([]).who).toBeNull();
  });

  it('a done step at when it finished, the next at when it is due, a later one at no time with its wait', () => {
    const { steps } = runSteps([
      step({ card: card('Send “Welcome”'), status: 'done', runAt: new Date('2026-11-28T01:00:00Z'), finishedAt: DONE }),
      step({ card: card('Text “Hi”'), status: 'scheduled', runAt: DUE, args: { gapHours: 2 } }),
      step({ card: card('Call task'), status: 'blocked', runAt: DUE, args: { gapHours: 24, window: { from: 540, to: 1020, days: [1], tz: 'Australia/Sydney' } } }),
    ]);
    expect(steps).toEqual([
      { title: 'Send “Welcome”', status: 'done', error: null, at: DONE, waitHours: 0, window: false },
      { title: 'Text “Hi”', status: 'scheduled', error: null, at: DUE, waitHours: 2, window: false },
      { title: 'Call task', status: 'blocked', error: null, at: null, waitHours: 24, window: true },
    ]);
  });

  it('a skipped step is never shown at the time it would have gone', () => {
    const { steps } = runSteps([step({ status: 'cancelled', runAt: DUE, error: 'Stopped by hand' }), step({ status: 'cancelled', runAt: DUE, finishedAt: DONE, error: 'Stopped: they emailed or texted back' })]);
    expect(steps.map((s) => s.at)).toEqual([null, null]);
    expect(runSteps([step({ status: 'running', runAt: DUE })]).steps[0]!.at).toEqual(DUE);
  });
});

describe('stepAfterWords', () => {
  it('says how long after the step before, and when it keeps to its hours', () => {
    expect(stepAfterWords(0, false)).toBe('Right after the step before');
    expect(stepAfterWords(2, false)).toBe('2 h after the step before');
    expect(stepAfterWords(72, true)).toBe('3 days after the step before, inside its hours');
  });
});
