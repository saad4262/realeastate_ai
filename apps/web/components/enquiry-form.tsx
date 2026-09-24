'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { enquiryInputSchema } from '@repo/core/leads/schema';
import { sendEnquiryAction } from '../lib/enquiry-action';

/**
 * The one interactive thing on the listing page.
 *
 * A client island by necessity — it has to show a validation message and a
 * sent state without navigating — and deliberately the only one, so the rest
 * of the page stays Server Components.
 *
 * The schema import is from `@repo/core/leads/schema`, the LEAF, not from
 * `@repo/core/leads`, which re-exports create-enquiry.ts → @repo/db →
 * postgres.js → `fs`. The same trap the listing card documents.
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
      <div className="rounded-lg border border-line-subtle bg-card p-lg shadow-card">
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

    // The same contract the server enforces, so a typo never costs a round
    // trip to come back as an error. The server never trusts this having run.
    const parsed = enquiryInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the highlighted fields');
      return;
    }
    setError(null);

    start(async () => {
      const result = await sendEnquiryAction(listingId, parsed.data);
      if (result.ok) setSent(true);
      else setError(result.error);
    });
  }

  const field =
    'w-full rounded-md border border-line bg-canvas px-md py-sm text-body-md text-ink ' +
    'placeholder:text-ink-faint focus:border-brand focus:outline-none';

  return (
    <form
      onSubmit={onSubmit}
      className="grid gap-sm rounded-lg border border-line-subtle bg-card p-lg shadow-card"
    >
      <div>
        <h2 className="text-headline-md font-display text-ink">Enquire</h2>
        <p className="mt-0.5 text-body-sm text-ink-soft">
          Your message goes to {agencyName}.
        </p>
      </div>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Name</span>
        <input name="name" required autoComplete="name" className={field} />
      </label>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Email</span>
        <input name="email" type="email" required autoComplete="email" className={field} />
      </label>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Phone (optional)</span>
        <input name="phone" type="tel" autoComplete="tel" className={field} />
      </label>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Message</span>
        <textarea
          name="message"
          rows={4}
          required
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
