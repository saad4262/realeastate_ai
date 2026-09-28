'use client';

import { useState } from 'react';
import { AU_TIMEZONES, timezoneLabel } from '@repo/core/schedules/timezones';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A clock face, not a shortlist.
 *
 * The time control was eight fixed options — 7 AM to 9 PM, on the hour. It
 * covered the common cases and quietly refused every other one: somebody who
 * wanted 4:15 PM had no way to say so and no way to tell that the product
 * could not, because a dropdown of eight times looks like a design rather
 * than a limit. The column has always been a minute of the day, so nothing
 * below this was standing in the way.
 *
 * Three selects rather than `<input type="time">`, which was the obvious
 * first choice: its 12-hour-vs-24-hour rendering follows the BROWSER's
 * locale, not the page's, so an AM/PM picker would silently become a
 * 24-hour one for some visitors. These are the same everywhere.
 */
const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES_60 = Array.from({ length: 60 }, (_, i) => i);

const field =
  'rounded-xl border border-line bg-canvas px-3 py-2 text-ink focus:border-brand focus:outline-none';
const narrow =
  'rounded-xl border border-line bg-canvas px-2.5 py-2 text-ink focus:border-brand focus:outline-none';

export type Cadence = 'daily' | 'weekly' | 'interval';

/** What an existing schedule looks like when it is being edited. */
export type ScheduleDefaults = {
  cadence: Cadence;
  /** Minute of the DAY, as stored. Split into the three controls below. */
  sendAtMinute: number;
  sendOnWeekday: number | null;
  intervalMinutes: number | null;
  timezone: string;
};

/**
 * The cadence controls, shared by "save a new search" and "edit this one".
 *
 * One component rather than two copies, and the reason is on the record: a
 * second copy of `describeCadence` living in `/alerts` is exactly how an
 * hourly schedule came to be labelled "Every day at 12:00 AM" for months.
 * A picker duplicated for an edit form would drift the same way, and the
 * drift would be silent — two forms writing the same columns from different
 * fields is not something that fails to compile.
 *
 * It renders fields and nothing else: no submit button, no action, no
 * fetch. The form around it owns all of that, which is what lets the same
 * fields feed a create action and an update action.
 */
export function SchedulePicker({ defaults }: { defaults?: ScheduleDefaults }) {
  const [cadence, setCadence] = useState<Cadence>(defaults?.cadence ?? 'daily');

  // Only the clock is split out; the rest are plain defaultValues below.
  const hour24 = Math.floor((defaults?.sendAtMinute ?? 20 * 60) / 60);
  const clock = {
    hour12: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute: (defaults?.sendAtMinute ?? 0) % 60,
    meridiem: hour24 < 12 ? 'AM' : 'PM',
  };

  /**
   * A stored gap is minutes; a person reads it in the largest unit it
   * divides into cleanly. 20160 shown as "20160 minutes" is technically
   * what is stored and useless to edit; "2 weeks" is the same value.
   */
  const stored = defaults?.intervalMinutes ?? 120;
  const unit =
    stored % (7 * 24 * 60) === 0
      ? 'weeks'
      : stored % (24 * 60) === 0
        ? 'days'
        : stored % 60 === 0
          ? 'hours'
          : 'minutes';
  const per = { minutes: 1, hours: 60, days: 24 * 60, weeks: 7 * 24 * 60 }[unit];

  return (
    <>
      <label className="block text-sm">
        <span className="text-ink-soft">How often</span>
        <select
          name="cadence"
          value={cadence}
          onChange={(e) => setCadence(e.target.value as Cadence)}
          className={`mt-1 w-full ${field}`}
        >
          <option value="daily">Every day</option>
          <option value="weekly">Once a week</option>
          <option value="interval">Every so often</option>
        </select>
      </label>

      {cadence === 'weekly' ? (
        <label className="block text-sm">
          <span className="text-ink-soft">On</span>
          <select
            name="sendOnWeekday"
            defaultValue={String(defaults?.sendOnWeekday ?? 1)}
            className={`mt-1 w-full ${field}`}
          >
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={index}>
                {day}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {cadence === 'interval' ? (
        <div className="block text-sm sm:col-span-2">
          <span className="text-ink-soft">Run it every</span>
          <div className="mt-1 flex gap-2">
            <input
              name="every"
              type="number"
              min={1}
              step={1}
              defaultValue={stored / per}
              aria-label="How many"
              className={`w-24 ${field}`}
            />
            <select
              name="everyUnit"
              defaultValue={unit}
              aria-label="Unit"
              className={`flex-1 ${field}`}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
          </div>
          {/* Both halves of the rule, said once, where the decision is made.
              The server enforces it either way. */}
          <p className="mt-1 text-xs text-ink-faint">
            At least 10 minutes apart. There is no upper limit — every 2 weeks or every 6
            months is fine.
          </p>
        </div>
      ) : (
        <div className="block text-sm">
          <span className="text-ink-soft">At</span>
          <div className="mt-1 flex items-center gap-1.5">
            <select
              name="sendAtHour"
              defaultValue={String(clock.hour12)}
              aria-label="Hour"
              className={narrow}
            >
              {HOURS_12.map((hour) => (
                <option key={hour} value={hour}>
                  {hour}
                </option>
              ))}
            </select>
            <span aria-hidden className="text-ink-soft">
              :
            </span>
            <select
              name="sendAtMinuteOfHour"
              defaultValue={String(clock.minute)}
              aria-label="Minute"
              className={narrow}
            >
              {MINUTES_60.map((minute) => (
                <option key={minute} value={minute}>
                  {String(minute).padStart(2, '0')}
                </option>
              ))}
            </select>
            <select
              name="sendAtMeridiem"
              defaultValue={clock.meridiem}
              aria-label="AM or PM"
              className={narrow}
            >
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>
        </div>
      )}

      {cadence === 'interval' ? null : (
        <label className="block text-sm">
          <span className="text-ink-soft">Your time zone</span>
          <select
            name="timezone"
            defaultValue={defaults?.timezone ?? 'Australia/Sydney'}
            className={`mt-1 w-full ${field}`}
          >
            {AU_TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {timezoneLabel(zone)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

/**
 * The one honest caveat, wherever the picker appears.
 *
 * The tick runs every 5 minutes, so a time is kept to within 5 minutes and
 * not to the second. Promising 4:15 PM exactly would be a promise the
 * scheduler cannot keep, and a picker that shows every minute of the day
 * implies precision it does not have unless this says otherwise.
 */
export function ScheduleAccuracyNote() {
  return (
    <p className="mt-2 text-xs text-ink-faint">
      We run these every few minutes, so an alert arrives within about 5 minutes of the time
      you pick.
    </p>
  );
}
