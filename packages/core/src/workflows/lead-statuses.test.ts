import { describe, expect, it } from 'vitest';
import { leadStatusEnum } from '@repo/db';
import { LEAD_STATUSES } from './catalog';

/** ADR 0107: the lead stages are written once in core (a browser-safe file) and must stay the database's. */
describe('lead stages', () => {
  it('are lead_status, in its order, Nurture included', () => {
    expect([...LEAD_STATUSES]).toEqual(leadStatusEnum.enumValues);
    expect(LEAD_STATUSES).toContain('nurture');
  });
});
