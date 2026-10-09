import { startOfDayIn, startOfMonthIn, startOfWeekIn, startOfYearIn } from '../time/local-input';

export const WIDGET_RANGES = ['today', '7d', '30d', '90d', 'this_week', 'this_month', 'last_month', 'this_year'] as const;
export type WidgetRange = (typeof WIDGET_RANGES)[number];

export const RANGE_LABELS: Record<WidgetRange, string> = {
  today: 'today',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
  this_week: 'this week',
  this_month: 'this month',
  last_month: 'last month',
  this_year: 'this year',
};

/** The time window a range means, on the agency's clock. `to` is exclusive. */
export function rangeWindow(range: WidgetRange, now: Date, tz: string): { from: Date; to: Date } {
  switch (range) {
    case 'today':
      return { from: startOfDayIn(now, tz), to: startOfDayIn(now, tz, 1) };
    case '7d':
      return { from: startOfDayIn(now, tz, -6), to: startOfDayIn(now, tz, 1) };
    case '30d':
      return { from: startOfDayIn(now, tz, -29), to: startOfDayIn(now, tz, 1) };
    case '90d':
      return { from: startOfDayIn(now, tz, -89), to: startOfDayIn(now, tz, 1) };
    case 'this_week':
      return { from: startOfWeekIn(now, tz), to: startOfWeekIn(now, tz, 1) };
    case 'this_month':
      return { from: startOfMonthIn(now, tz), to: startOfMonthIn(now, tz, 1) };
    case 'last_month':
      return { from: startOfMonthIn(now, tz, -1), to: startOfMonthIn(now, tz) };
    case 'this_year':
      return { from: startOfYearIn(now, tz), to: startOfDayIn(now, tz, 1) };
  }
}


/**
 * The window a range is compared with, and how to say so. A period still under
 * way (today, this week/month/year) is compared with the same point in the one
 * before — "this month so far" against "last month's first 9 days", never a
 * whole month — so the change is a like-for-like one.
 */
export function previousWindow(range: WidgetRange, now: Date, tz: string): { from: Date; to: Date; label: string } {
  const { from } = rangeWindow(range, now, tz);
  const elapsed = Math.max(0, now.getTime() - from.getTime());
  const soFar = (start: Date, cap: Date) => new Date(Math.min(start.getTime() + elapsed, cap.getTime()));
  switch (range) {
    case 'today': {
      const y = startOfDayIn(now, tz, -1);
      return { from: y, to: soFar(y, from), label: 'vs yesterday by this time' };
    }
    case '7d':
    case '30d':
    case '90d': {
      const n = { '7d': 7, '30d': 30, '90d': 90 }[range];
      return { from: startOfDayIn(now, tz, -(2 * n - 1)), to: startOfDayIn(now, tz, -(n - 1)), label: `vs the ${n} days before` };
    }
    case 'this_week': {
      const w = startOfWeekIn(now, tz, -1);
      return { from: w, to: soFar(w, from), label: 'vs the same point last week' };
    }
    case 'this_month': {
      const m = startOfMonthIn(now, tz, -1);
      return { from: m, to: soFar(m, from), label: 'vs the same point last month' };
    }
    case 'last_month':
      return { from: startOfMonthIn(now, tz, -2), to: startOfMonthIn(now, tz, -1), label: 'vs the month before' };
    case 'this_year': {
      const yr = startOfYearIn(new Date(from.getTime() - 86_400_000), tz);
      return { from: yr, to: soFar(yr, from), label: 'vs the same point last year' };
    }
  }
}

export type Bucket = 'hour' | 'day' | 'week' | 'month';

/** How finely a window's trend is cut, and how each step is labelled (Postgres `to_char`). */
export function bucketFor(from: Date, to: Date): { unit: Bucket; format: string } {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days <= 1.01) return { unit: 'hour', format: 'HH24:00' };
  if (days <= 35) return { unit: 'day', format: 'Dy DD Mon' };
  if (days <= 100) return { unit: 'week', format: 'DD Mon' };
  return { unit: 'month', format: 'Mon YYYY' };
}
