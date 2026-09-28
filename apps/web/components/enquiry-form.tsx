'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { sendEnquiryAction } from '../lib/enquiry-action';

/**
 * The one interactive thing on the listing page.
 *
 * A client island by necessity — it has to show a validation message and a
 * sent state without navigating — and deliberately the only one, so the rest
 * of the page stays Server Components.
 *
 * It validates with the browser's own constraints — required, type="email",
 * minLength — and NOT with the zod schema the server uses.
 *
 * Importing that schema here was the first version, on the same reasoning the
 * console's listing form uses: one contract, no round trip for a typo. It cost
 * 14 kB of First Load JS on every listing page (108 kB -> 122 kB) to save a
 * round trip on a form most visitors never open. The console form is a
 * different trade — it is behind a login, it is the tool of someone's job, and
 * it has twenty fields. This has four, and the constraints below express all
 * of them.
 *
 * The server re-validates regardless, so nothing is weakened: a browser with
 * validation disabled gets the same answer, one round trip later.
 */
export function EnquiryForm({
  listingId,
  agencyName,
}: {
  listingId: string;
  agencyName: string;
}) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  if (sent) {
    return (
      <div id="enquire" className="rounded-lg border border-line-subtle bg-card p-lg shadow-card">
        <h2 className="text-headline-md font-display text-ink">Enquiry sent</h2>
        <p className="mt-1 text-body-md text-ink-soft">
          {agencyName} has your message and will be in touch.
        </p>
      </div>
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      name: String(data.get('name') ?? ''),
      email: String(data.get('email') ?? ''),
      phone: String(data.get('phone') ?? '') || undefined,
      message: String(data.get('message') ?? ''),
    };
    setError(null);

    start(async () => {
      const result = await sendEnquiryAction(listingId, input);
      if (result.ok) setSent(true);
      else setError(result.error);
    });
  }

  const field =
    'w-full rounded-md border border-line bg-canvas px-md py-sm text-body-md text-ink ' +
    'placeholder:text-ink-faint focus:border-brand focus:outline-none';

  return (
    <form
      /* The anchor /search links to. A result row's "Enquire now" opens this
         page at the form rather than at the top of it, which on a phone is
         several screens above. The id is on both branches, so following the
         link after a message has been sent still lands on the confirmation. */
      id="enquire"
      onSubmit={onSubmit}
      className="grid gap-sm scroll-mt-xl rounded-lg border border-line-subtle bg-card p-lg shadow-card"
    >
      <div>
        <h2 className="text-headline-md font-display text-ink">Enquire</h2>
        <p className="mt-0.5 text-body-sm text-ink-soft">
          Your message goes to {agencyName}.
        </p>
      </div>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Name</span>
        <input name="name" required minLength={2} maxLength={120} autoComplete="name" className={field} />
      </label>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Email</span>
        <input name="email" type="email" required maxLength={200} autoComplete="email" className={field} />
      </label>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Phone (optional)</span>
        <input name="phone" type="tel" maxLength={40} autoComplete="tel" className={field} />
      </label>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Message</span>
        <textarea
          name="message"
          rows={4}
          required
          minLength={10}
          maxLength={2000}
          defaultValue="I'd like to know more about this property."
          className={`${field} resize-y`}
        />
      </label>

      {error ? (
        <p role="alert" className="text-body-sm text-alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-brand px-md py-sm text-body-md text-brand-ink transition hover:opacity-90 disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Send enquiry'}
      </button>

      <p className="text-body-sm text-ink-faint">
        Your details go to the agency marketing this property, and nowhere else.
      </p>
    </form>
  );
}
