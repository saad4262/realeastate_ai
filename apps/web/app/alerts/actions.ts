'use server';

import { revalidatePath } from 'next/cache';
import {
  clockInputSchema,
  createSchedule,
  deleteSchedule,
  intervalInputSchema,
  intervalMinutesFrom,
  MIN_INTERVAL_MINUTES,
  minutesFrom12Hour,
  ScheduleError,
  updateSchedule,
} from '@repo/core/schedules';
import { ensureConsumerAccount } from '../../lib/account';
import { getWebDb } from '../../lib/db';

export type ScheduleActionResult = { ok: true } | { ok: false; error: string };

/**
 * The actor, from the session and nowhere else.
 *
 * ADR 0006's lesson, applied here: an earlier version of the console's
 * equivalent took `userId` from the client, which let a caller mint a
 * membership for somebody else. A saved search sends email in its owner's
 * name, so the same mistake here would let one person aim mail at another.
 *
 * `ensureConsumerAccount` rather than a bare header read, because the
 * `search_schedule.user_id` foreign key needs the `public.user` row to
 * exist — and for a magic-link signup this action can be the first thing
 * that touches the database.
 */
async function actor() {
  const user = await ensureConsumerAccount();
  if (!user) throw new ScheduleError('Sign in to save a search', 'refused');
  return { userId: user.id };
}

function toResult(err: unknown): ScheduleActionResult {
  if (err instanceof ScheduleError) return { ok: false, error: err.message };
  return { ok: false, error: 'Something went wrong. Try again.' };
}

/**
 * The clock the form sent, as a minute of the day.
 *
 * Parsed here rather than computed in the browser. The picker is three
 * selects and it would have been one line to multiply them out client-side
 * and post a hidden `sendAtMinute` — but then the number that decides when
 * mail goes out would be one the browser chose, and § 9 is that
 * authorisation and meaning are what the server decides rather than what it
 * accepts. It also means the form still works with JavaScript off.
 */
function sendAtMinuteFrom(formData: FormData): number {
  /**
   * `sendAtMinuteOfHour`, not `sendAtMinute`.
   *
   * The column is a minute of the DAY (0–1439) and this field is a minute
   * of the HOUR (0–59). They were briefly the same name while this picker
   * was being written, which is one careless edit away from a schedule set
   * for 8:00 PM being stored as 12:20 AM. The names now say which is which.
   */
  const parsed = clockInputSchema.safeParse({
    hour12: formData.get('sendAtHour'),
    minute: formData.get('sendAtMinuteOfHour'),
    meridiem: formData.get('sendAtMeridiem'),
  });

  if (!parsed.success) throw new ScheduleError('Pick a time of day', 'invalid');
  return minutesFrom12Hour(parsed.data);
}

function intervalMinutesFromForm(formData: FormData): number {
  const parsed = intervalInputSchema.safeParse({
    every: formData.get('every'),
    unit: formData.get('everyUnit'),
  });

  if (!parsed.success) throw new ScheduleError('Say how far apart the runs should be', 'invalid');

  const minutes = intervalMinutesFrom(parsed.data.every, parsed.data.unit);

  /**
   * Refused, not clamped.
   *
   * The chat's `draft_schedule` clamps an out-of-range gap up to the floor,
   * because a model that has begun a sentence will narrate a refusal as
   * success and the visitor sees no card. A form has none of that problem:
   * it can put the reason next to the field, and quietly saving something
   * other than what somebody typed into a box is the worse failure here.
   */
  if (minutes < MIN_INTERVAL_MINUTES) {
    throw new ScheduleError(
      `The shortest gap we can run is every ${MIN_INTERVAL_MINUTES} minutes.`,
      'invalid',
    );
  }

  return minutes;
}

export async function createScheduleAction(formData: FormData): Promise<ScheduleActionResult> {
  try {
    const { sendOnWeekday, intervalMinutes, ...timing } = cadenceFieldsFrom(formData);

    await createSchedule(getWebDb(), await actor(), {
      searchPath: String(formData.get('searchPath') ?? ''),
      prompt: String(formData.get('prompt') ?? '') || undefined,
      name: String(formData.get('name') ?? '') || undefined,
      ...timing,
      /*
        Create and update differ here, and only here. A patch uses `null` to
        mean "clear it"; a create has nothing to clear, and the contract
        refuses a daily schedule that carries a weekday at all rather than
        ignoring it. So the field is omitted rather than nulled.
      */
      ...(sendOnWeekday === null ? {} : { sendOnWeekday }),
      ...(intervalMinutes === null ? {} : { intervalMinutes }),
    });

    revalidatePath('/alerts');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

/**
 * The cadence fields, merged onto whatever the schedule already is.
 *
 * Shared by create and update because they are fed by the same picker — one
 * component, so one parser. `sendOnWeekday` and `intervalMinutes` are set to
 * `null` rather than left out when they do not apply: in a patch, absent
 * means "leave it" and `null` means "clear it", and switching weekly → daily
 * has to clear the weekday or the row ends up carrying two different answers
 * to "when does this fire".
 */
function cadenceFieldsFrom(formData: FormData) {
  const cadence = String(formData.get('cadence') ?? 'daily');
  const weekdayRaw = formData.get('sendOnWeekday');

  return {
    cadence,
    // An interval fires on elapsed time and has no wall clock in it, so it
    // is given the one value the column will accept rather than a time
    // somebody might think means something.
    sendAtMinute: cadence === 'interval' ? 0 : sendAtMinuteFrom(formData),
    timezone: String(formData.get('timezone') ?? 'Australia/Sydney'),
    sendOnWeekday: cadence === 'weekly' && weekdayRaw !== null ? Number(weekdayRaw) : null,
    intervalMinutes: cadence === 'interval' ? intervalMinutesFromForm(formData) : null,
  };
}

/**
 * Change the time, day or frequency of a schedule that already exists.
 *
 * The id comes from the form and the ownership check does not: `can()` is
 * given the row that was actually read, so a browser posting somebody else's
 * id gets "No such saved search" rather than an edit. That is `updateSchedule`'s
 * own rule and this action adds nothing to it.
 *
 * Resuming is deliberately not part of this. `updateSchedule` re-anchors the
 * cursor when the timing changes, so an edit lands on the next real slot —
 * but a paused schedule stays paused, because editing the time of something
 * switched off is not a request to switch it back on.
 */
export async function updateScheduleAction(formData: FormData): Promise<ScheduleActionResult> {
  try {
    const id = String(formData.get('scheduleId') ?? '');
    if (!id) throw new ScheduleError('No such saved search', 'not_found');

    const name = String(formData.get('name') ?? '').trim();

    await updateSchedule(getWebDb(), await actor(), id, {
      ...(name ? { name } : {}),
      ...cadenceFieldsFrom(formData),
    });

    revalidatePath('/alerts');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

export async function setScheduleStatusAction(
  scheduleId: string,
  status: 'active' | 'paused',
): Promise<ScheduleActionResult> {
  try {
    await updateSchedule(getWebDb(), await actor(), scheduleId, { status });
    revalidatePath('/alerts');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}

export async function deleteScheduleAction(scheduleId: string): Promise<ScheduleActionResult> {
  try {
    await deleteSchedule(getWebDb(), await actor(), scheduleId);
    revalidatePath('/alerts');
    return { ok: true };
  } catch (err) {
    return toResult(err);
  }
}
