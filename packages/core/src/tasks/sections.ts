import { z } from 'zod';
import { auStateSchema, propertyTypeSchema } from '../listings/listing-schema';
import { auTimezoneSchema, sendAtMinuteSchema, sendOnWeekdaySchema } from '../schedules/schedule-schema';
import type { SavedSearchQuery } from '../listings/search-url';

/**
 * Tasks (ADR 0080, C8 decisions 5–7; mock docs/mocks/consumer-acting.html#tasks): research done once or on a schedule,
 * on the Smart Alerts runner. A report is made of sections from this fixed list, up to four, every figure in them from
 * SQL. Pure — the contract and the words.
 */

export const TASK_SECTIONS = ['new_homes', 'sold', 'price_reduced', 'long_campaign', 'suburb_figures', 'open_homes', 'watched'] as const;
export type TaskSection = (typeof TASK_SECTIONS)[number];
export const MAX_TASKS = 10;
export const MAX_TASK_SECTIONS = 4;
export const TASK_CADENCES = ['once', 'daily', 'weekly'] as const;

export const TASK_SECTION_TEXT: Record<TaskSection, { title: string; pick: string; needs: 'suburb' | 'area' | 'nothing' }> = {
  new_homes: { title: 'New homes for your search', pick: 'New homes for my search', needs: 'area' },
  sold: { title: 'What sold', pick: 'What sold', needs: 'suburb' },
  price_reduced: { title: 'Price reductions', pick: 'Price reductions', needs: 'area' },
  long_campaign: { title: 'On the market 60+ days', pick: 'Long campaigns', needs: 'area' },
  suburb_figures: { title: 'The suburb on this site', pick: 'Suburb figures', needs: 'suburb' },
  open_homes: { title: 'Open homes in the next 7 days', pick: 'Open homes, next 7 days (my search and shortlist)', needs: 'nothing' },
  watched: { title: 'At the addresses you watch', pick: 'My watched addresses', needs: 'nothing' },
};

/** Sections that report what HAPPENED; the other two describe what stands. A run is "news" when one of these has a row. */
export const NEWS_SECTIONS: ReadonlySet<TaskSection> = new Set(['new_homes', 'sold', 'price_reduced', 'open_homes', 'watched']);

/** Where a task looks: a search's filters, stored as the frozen query a saved search uses. */
export const taskAreaSchema = z
  .object({
    suburb: z.string().trim().min(1).max(80).optional(),
    state: auStateSchema.optional(),
    channel: z.enum(['sale', 'rent']).default('sale'),
    priceTo: z.number().int().positive().max(100_000_000).optional(),
    bedrooms: z.number().int().min(0).max(20).optional(),
    propertyType: propertyTypeSchema.optional(),
  })
  .strict();
export type TaskArea = z.infer<typeof taskAreaSchema>;

export const taskInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    area: taskAreaSchema,
    sections: z.array(z.enum(TASK_SECTIONS)).min(1, 'Choose at least one thing for the report').max(MAX_TASK_SECTIONS, `Up to ${MAX_TASK_SECTIONS} things in one report`),
    cadence: z.enum(TASK_CADENCES),
    sendAtMinute: sendAtMinuteSchema,
    sendOnWeekday: sendOnWeekdaySchema.optional(),
    timezone: auTimezoneSchema,
    skipEmpty: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.sections).size !== v.sections.length) ctx.addIssue({ code: 'custom', message: 'Each section once', path: ['sections'] });
    if (v.cadence === 'weekly' && v.sendOnWeekday === undefined) ctx.addIssue({ code: 'custom', message: 'Choose the day of the week', path: ['sendOnWeekday'] });
    for (const s of v.sections) {
      const needs = TASK_SECTION_TEXT[s].needs;
      if (needs === 'suburb' && !v.area.suburb) ctx.addIssue({ code: 'custom', message: `“${TASK_SECTION_TEXT[s].pick}” needs a suburb`, path: ['area', 'suburb'] });
      if (needs === 'area' && !v.area.suburb && !v.area.state) ctx.addIssue({ code: 'custom', message: `“${TASK_SECTION_TEXT[s].pick}” needs a suburb or a state`, path: ['area'] });
    }
  });
export type TaskInput = z.infer<typeof taskInputSchema>;

/** The area as the saved-search query the runner stores and the claim parses. Pure. */
export function areaQuery(area: TaskArea): SavedSearchQuery {
  return {
    ...(area.suburb ? { suburb: area.suburb } : {}),
    ...(area.state ? { state: area.state } : {}),
    channel: area.channel,
    ...(area.priceTo !== undefined ? { priceTo: area.priceTo } : {}),
    ...(area.bedrooms !== undefined ? { bedrooms: area.bedrooms } : {}),
    ...(area.propertyType ? { propertyType: area.propertyType } : {}),
  };
}

/** The stored sections, read back defensively: a row this version cannot read reports nothing rather than guessing. */
export function readSections(raw: unknown): TaskSection[] {
  return Array.isArray(raw) ? raw.filter((s): s is TaskSection => (TASK_SECTIONS as readonly string[]).includes(s as string)).slice(0, MAX_TASK_SECTIONS) : [];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function timeText(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** "Every Monday, 7:00 am" / "Every day, 7:00 am" / "Once, 7:00 am". Pure. */
export function whenText(t: { cadence: string; sendAtMinute: number; sendOnWeekday?: number | null }): string {
  const at = timeText(t.sendAtMinute);
  if (t.cadence === 'weekly' && t.sendOnWeekday !== null && t.sendOnWeekday !== undefined) return `Every ${WEEKDAYS[t.sendOnWeekday]}, ${at}`;
  if (t.cadence === 'once') return `Once, ${at}`;
  return `Every day, ${at}`;
}

// ── the paragraph at the top (decision 7): the Smart Alerts rule, and C5's verdict rule ──

/** A number in digits, or a counting word: the paragraph is handed no figures and may not invent one. */
const COUNTING = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|couple|pair|single|several|handful|first|second|third|half|double|triple)\b/i;

export function taskSummaryPasses(text: string, passesVerdictRule: (t: string) => boolean): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 400 && !COUNTING.test(t) && passesVerdictRule(t);
}

export function taskTemplateSummary(name: string, hasNews: boolean): string {
  return hasNews ? `Your report “${name}” is below.` : `Nothing new for “${name}” since the last report.`;
}
