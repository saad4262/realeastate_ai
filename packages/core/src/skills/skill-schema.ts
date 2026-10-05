import { z } from 'zod';
import { isIntegrationProvider, type IntegrationProvider } from '../integrations/providers';
import { isValidTimeZone } from '../time/local-input';

/**
 * The contracts for skills (docs/adr/0021). Pure — the console's editor and
 * the runner both use them. Vocabularies mirror the database enums; the test
 * fails if they drift.
 */

export const SKILL_HANDLERS = ['morning_brief', 'important_emails'] as const;
export type SkillHandler = (typeof SKILL_HANDLERS)[number];
export const SKILL_HANDLER_LABELS: Record<SkillHandler, string> = {
  morning_brief: 'Morning Brief',
  important_emails: 'Most important emails',
};

export const SKILL_MODEL_TIERS = ['summary', 'agent', 'hard'] as const;
export type SkillModelTier = (typeof SKILL_MODEL_TIERS)[number];

export const SKILL_RUN_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;
export type SkillRunStatus = (typeof SKILL_RUN_STATUSES)[number];

export const MAX_SKILL_BODY = 8000;

export type SkillSchedule =
  | { cadence: 'daily'; sendAtMinute: number }
  | { cadence: 'weekly'; sendAtMinute: number; sendOnWeekday: number }
  | { cadence: 'interval'; intervalMinutes: number; sendAtMinute: number };

export type ParsedSkillMarkdown = {
  requires: IntegrationProvider[];
  model: SkillModelTier | null;
  schedule: SkillSchedule | null;
  /** The instructions: everything after the front-matter. */
  instructions: string;
  /** Problems a person can fix. Empty means the Markdown is usable. */
  errors: string[];
};

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseTime(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

/** `daily 07:00`, `weekly mon 07:00`, `every 2h`. */
export function parseScheduleLine(v: string): SkillSchedule | null {
  const s = v.trim().toLowerCase();
  let m = /^daily\s+(\S+)$/.exec(s);
  if (m) {
    const t = parseTime(m[1]!);
    return t === null ? null : { cadence: 'daily', sendAtMinute: t };
  }
  m = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\S+)$/.exec(s);
  if (m) {
    const t = parseTime(m[2]!);
    return t === null ? null : { cadence: 'weekly', sendAtMinute: t, sendOnWeekday: WEEKDAYS.indexOf(m[1]!) };
  }
  m = /^every\s+(\d{1,2})h$/.exec(s);
  if (m) {
    const hours = Number(m[1]);
    return hours >= 1 && hours <= 24 ? { cadence: 'interval', intervalMinutes: hours * 60, sendAtMinute: 0 } : null;
  }
  return null;
}

/**
 * The `---` front-matter and the instructions under it. A deliberately small
 * reader — three keys, no YAML library — so what it accepts is exactly what
 * this file says.
 */
export function parseSkillMarkdown(md: string): ParsedSkillMarkdown {
  const out: ParsedSkillMarkdown = { requires: [], model: null, schedule: null, instructions: md.trim(), errors: [] };
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return out;
  out.instructions = (m[2] ?? '').trim();
  for (const raw of (m[1] ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const kv = /^([a-z_]+)\s*:\s*(.*)$/i.exec(line);
    if (!kv) {
      out.errors.push(`Front-matter line not understood: "${line.slice(0, 60)}"`);
      continue;
    }
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (key === 'requires') {
      const list = value.replace(/^\[|\]$/g, '').split(',').map((v) => v.trim()).filter(Boolean);
      for (const p of list) {
        if (isIntegrationProvider(p)) out.requires.push(p);
        else out.errors.push(`Unknown integration in requires: "${p}"`);
      }
    } else if (key === 'model') {
      if ((SKILL_MODEL_TIERS as readonly string[]).includes(value)) out.model = value as SkillModelTier;
      else out.errors.push(`model must be one of ${SKILL_MODEL_TIERS.join(', ')}`);
    } else if (key === 'schedule') {
      const sched = parseScheduleLine(value);
      if (sched) out.schedule = sched;
      else out.errors.push('schedule must look like "daily 07:00", "weekly mon 07:00" or "every 2h"');
    } else {
      out.errors.push(`Unknown front-matter key: "${key}"`);
    }
  }
  if (!out.instructions) out.errors.push('Write the instructions under the front-matter');
  return out;
}

/** An agent's schedule, as the form sends it. The zone is the browser's. */
export const skillScheduleSchema = z
  .object({
    cadence: z.enum(['daily', 'weekly', 'interval']),
    /** `HH:MM`, on the agent's clock. */
    time: z.string().regex(/^\d{2}:\d{2}$/, 'Pick a time'),
    sendOnWeekday: z.coerce.number().int().min(0).max(6).optional(),
    intervalHours: z.coerce.number().int().min(1, 'At least every hour').max(24).optional(),
    timezone: z.string().refine(isValidTimeZone, 'Unknown timezone'),
  })
  .refine((v) => v.cadence !== 'weekly' || v.sendOnWeekday !== undefined, { message: 'Pick a day', path: ['sendOnWeekday'] })
  .refine((v) => v.cadence !== 'interval' || v.intervalHours !== undefined, { message: 'Pick how often', path: ['intervalHours'] });
export type SkillScheduleInput = z.input<typeof skillScheduleSchema>;

export function scheduleFromInput(v: z.output<typeof skillScheduleSchema>): {
  cadence: 'daily' | 'weekly' | 'interval';
  sendAtMinute: number;
  sendOnWeekday: number | null;
  intervalMinutes: number | null;
} {
  const [h, m] = v.time.split(':').map(Number) as [number, number];
  return {
    cadence: v.cadence,
    sendAtMinute: Math.min(1439, h * 60 + m),
    sendOnWeekday: v.cadence === 'weekly' ? (v.sendOnWeekday ?? 1) : null,
    intervalMinutes: v.cadence === 'interval' ? (v.intervalHours ?? 1) * 60 : null,
  };
}

export const skillBodySchema = z
  .string()
  .max(MAX_SKILL_BODY, `Keep a skill under ${MAX_SKILL_BODY.toLocaleString('en-AU')} characters`)
  .superRefine((md, ctx) => {
    for (const e of parseSkillMarkdown(md).errors) ctx.addIssue({ code: z.ZodIssueCode.custom, message: e });
  });

export const librarySkillSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(5).max(300),
  handler: z.enum(SKILL_HANDLERS),
  bodyMd: skillBodySchema,
});
export type LibrarySkillInput = z.input<typeof librarySkillSchema>;
