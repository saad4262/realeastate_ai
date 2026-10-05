'use client';

import { useEffect, useState } from 'react';

/**
 * A timestamp in the reader's own time zone.
 *
 * The server has no idea where the reader is, so it renders Sydney time (the
 * agencies' zone) and the browser re-formats in its own zone once mounted.
 * Renders text only — wrap it in the page's own `<time dateTime=…>`.
 */

export type LocalTimeStyle = 'short' | 'full' | 'date';

const SERVER_ZONE = 'Australia/Sydney';

function formatters(timeZone: string | undefined) {
  return {
    day: new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone }),
    clock: new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', timeZone }),
    date: new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone }),
    full: new Intl.DateTimeFormat('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }),
  };
}

function format(iso: string, style: LocalTimeStyle, timeZone: string | undefined): string {
  const f = formatters(timeZone);
  const when = new Date(iso);
  if (style === 'full') return f.full.format(when);
  if (style === 'date') return f.date.format(when);
  // A mail list: today shows the time, anything older shows the date.
  return f.day.format(when) === f.day.format(new Date()) ? f.clock.format(when) : f.day.format(when);
}

export function LocalTime({ iso, style = 'full' }: { iso: string; style?: LocalTimeStyle }) {
  const [text, setText] = useState(() => format(iso, style, SERVER_ZONE));
  useEffect(() => {
    // undefined = the browser's own zone.
    setText(format(iso, style, undefined));
  }, [iso, style]);
  return <>{text}</>;
}
