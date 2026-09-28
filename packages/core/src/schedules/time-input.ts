import { z } from 'zod';

/**
 * Turning what a person picks into what the database stores.
 *
 * Two conversions, both of which look trivial and both of which have a
 * classic wrong answer. They live in core rather than in the form because
 * the form is not the only caller — the chat's `draft_schedule` reaches the
 * same columns — and because a rule with two implementations has two
 * behaviours (#8, in spirit).
 */

export const MERIDIEMS = ['AM', 'PM'] as const;
export type Meridiem = (typeof MERIDIEMS)[number];

/** 1–12, as written on a clock face. Not 0-indexed, not 24-hour. */
export const hour12Schema = z.number().int().min(1).max(12);
export const minuteOfHourSchema = z.number().int().min(0).max(59);
export const meridiemSchema = z.enum(MERIDIEMS);

/**
 * "4:15 PM" → 975.
 *
 * The trap is noon and midnight. 12 AM is 0 and 12 PM is 720, which is the
 * opposite of what `hour12 + 12` gives for either — the naive version puts
 * midnight at 12:00 and noon at 24:00, and a daily alert set for midnight
 * would have fired at lunchtime.
 */
export function minutesFrom12Hour(input: {
  hour12: number;
  minute: number;
  meridiem: Meridiem;
}): number {
  const hour12 = hour12Schema.parse(input.hour12);
  const minute = minuteOfHourSchema.parse(input.minute);
  const meridiem = meridiemSchema.parse(input.meridiem);

  const hour24 = meridiem === 'AM' ? hour12 % 12 : (hour12 % 12) + 12;
  return hour24 * 60 + minute;
}

/** The inverse, for showing a stored schedule back in the picker it came from. */
export function to12Hour(minuteOfDay: number): {
  hour12: number;
  minute: number;
  meridiem: Meridiem;
} {
  const hour24 = Math.floor(minuteOfDay / 60);
  return {
    hour12: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute: minuteOfDay % 60,
    meridiem: hour24 < 12 ? 'AM' : 'PM',
  };
}

export const INTERVAL_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export const intervalUnitSchema = z.enum(INTERVAL_UNITS);

const PER_UNIT: Record<IntervalUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 24 * 60,
  weeks: 7 * 24 * 60,
};

/**
 * "every 3 days" → 4320 minutes.
 *
 * Unbounded above on purpose — see MAX_INTERVAL_MINUTES, which is a storage
 * ceiling rather than a product limit. The floor is not enforced here: this
 * function converts, and `intervalMinutesSchema` decides what is allowed, so
 * that there is exactly one place the 10-minute rule is written down.
 */
export function intervalMinutesFrom(value: number, unit: IntervalUnit): number {
  return Math.round(value * PER_UNIT[intervalUnitSchema.parse(unit)]);
}

/**
 * The clock fields as a form sends them — strings, every one.
 *
 * `coerce` rather than `Number(...)` at the call site: an empty select gives
 * `''`, which `Number('')` turns into 0, which is a valid hour and a silently
 * wrong answer. Coercion through zod rejects it instead.
 */
export const clockInputSchema = z.object({
  hour12: z.coerce.number().int().min(1).max(12),
  minute: z.coerce.number().int().min(0).max(59),
  meridiem: meridiemSchema,
});

export const intervalInputSchema = z.object({
  every: z.coerce.number().positive(),
  unit: intervalUnitSchema,
});
