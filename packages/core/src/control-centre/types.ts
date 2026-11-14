import { z } from 'zod';

/** The Control Centre's shapes and words (ADR 0091). No database here: the page's filters import this file. */

export const CC_SOURCES = ['workflow', 'automation', 'phone', 'opportunity', 'skill'] as const;
export type CcSource = (typeof CC_SOURCES)[number];

export const CC_RANGES = ['24h', '7d', '30d'] as const;
export type CcRange = (typeof CC_RANGES)[number];
export const CC_RANGE_HOURS: Record<CcRange, number> = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24 };

/** A tile's filter on the list. `bad` is failed or skipped. */
export const CC_RESULT_FILTERS = ['all', 'ok', 'wait', 'bad'] as const;

/** A step's level as it runs today. `human` arrives with the client's decision 2 (ADR 0091, part D). */
export type CcLevel = 'auto' | 'approve';
export type CcResult = 'ok' | 'running' | 'wait' | 'skip' | 'bad';

export const CC_PAGE_SIZE = 50;

/** The URL is the state. A bad value falls back rather than failing the page. */
export const controlCentreQuerySchema = z.object({
  range: z.enum(CC_RANGES).catch('24h'),
  source: z.enum(['all', ...CC_SOURCES]).catch('all'),
  result: z.enum(CC_RESULT_FILTERS).catch('all'),
  who: z.string().uuid().optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});
export type ControlCentreQuery = z.infer<typeof controlCentreQuerySchema>;

export type ControlCentreRow = {
  /** `source:id`, unique across the feed. */
  key: string;
  source: CcSource;
  id: string;
  at: string;
  what: string;
  sub: string | null;
  level: CcLevel;
  result: CcResult;
  /** Why, in words: an error, a skip reason, what the phone did. */
  note: string | null;
  ai: boolean;
  /** Whose it is, when it is not the person looking. */
  owner: string | null;
  mine: boolean;
};

/** Every figure counted in SQL over the range (non-negotiable 4). `waiting` is now, whatever the range. */
export type ControlCentreTiles = { ran: number; tasks: number; sent: number; opportunities: number; waiting: number; failed: number };

export type ControlCentreActivity = {
  tiles: ControlCentreTiles;
  rows: ControlCentreRow[];
  total: number;
  page: number;
  pageSize: number;
  /** For the person filter: whose rows are in the range. Null for someone who sees only their own. */
  people: { id: string; name: string }[] | null;
};

export const CC_SOURCE_WORDS: Record<CcSource, string> = {
  workflow: 'Workflow',
  automation: 'Automation',
  phone: 'Phone & SMS',
  opportunity: 'Opportunity',
  skill: 'Skill',
};

export const CC_LEVEL_WORDS: Record<CcLevel, string> = { auto: 'Automatic', approve: 'Needs approval' };

export const OPPORTUNITY_WORDS: Record<string, string> = {
  sale_anniversary: 'Sale anniversary',
  cold_contact: 'Cold contact',
  unanswered_mail: 'Unanswered email',
  appraisal_follow_up: 'Appraisal follow-up',
  repeat_interest: 'Repeat interest',
};

/** `phone_call.outcome` (ADR 0071). */
export const MISSED_CALL_WORDS: Record<string, string> = {
  texted: 'Texted from the agent’s number',
  skill_off: 'Not texted: Missed call text is off',
  private: 'Not texted: a private number',
  not_mobile: 'Not texted: not a mobile',
  opted_out: 'Not texted: they replied STOP',
  repeat: 'Not texted: already texted today',
  limit: 'Not texted: the daily limit',
  text_failed: 'The text failed',
};

/** `phone_call.ai_status` (ADR 0072). */
export const AI_CALLBACK_WORDS: Record<string, string> = {
  scheduled: 'AI call back booked',
  calling: 'AI calling back now',
  done: 'AI called back',
  no_answer: 'AI called back, no answer',
  skipped: 'AI call back skipped',
  failed: 'AI call back failed',
};
