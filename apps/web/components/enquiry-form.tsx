'use client';

import { useRef, useState, useTransition, type FormEvent } from 'react';
import { sendEnquiryAction } from '../lib/enquiry-action';
import { sendGuideMessageAction } from '../lib/acting-actions';
import { Spinner } from './spinner';

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
  /** Agent AI (ADR 0080, C8): set when the guide drafted the message — it is then sent from the account, as a guide draft. */
  const [guide, setGuide] = useState<{ token: string; note: string } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  async function draftWithAi() {
    const words = box.current?.value.trim() ?? '';
    setError(null);
    setDrafting(true);
    try {
      const res = await fetch('/api/agent-message/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingId, words }) });
      const body = (await res.json().catch(() => null)) as { text?: string; token?: string; agencyName?: string; sentToday?: number; perDay?: number; error?: string } | null;
      if (!res.ok || !body?.text || !body.token) return setError(body?.error ?? 'The draft could not be written just now.');
      if (box.current) box.current.value = body.text;
      setGuide({ token: body.token, note: `Drafted with the guide from your words — read it and change anything. It goes from your account's name and email when you press Send (${body.sentToday ?? 0} of ${body.perDay ?? 5} today).` });
    } finally {
      setDrafting(false);
    }
  }

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
      // A guide draft goes from the account through Agent AI's send (5 a day); a message the buyer wrote, as always.
      const result = guide ? await sendGuideMessageAction(guide.token, input.message) : await sendEnquiryAction(listingId, input);
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
          ref={box}
          className={`${field} resize-y`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={draftWithAi} disabled={drafting || busy} className="rounded-full border border-line bg-white px-3 py-1 text-body-sm text-ink disabled:opacity-60">
          {drafting ? 'Drafting…' : 'Draft with AI from my words'}
        </button>
        {guide ? <span className="text-body-sm text-ink-soft">{guide.note}</span> : <span className="text-label-sm text-ink-faint">Type what you want to ask, in a few words. Needs Agent AI on.</span>}
      </div>

      {error ? (
        <p role="alert" className="text-body-sm text-alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="inline-flex items-center justify-center gap-2 rounded-md bg-brand px-md py-sm text-body-md text-brand-ink transition hover:opacity-90 disabled:opacity-60"
      >
        {busy ? (
          <>
            <Spinner /> Sending…
          </>
        ) : (
          'Send enquiry'
        )}
      </button>

      <p className="text-body-sm text-ink-faint">
        Your details go to the agency marketing this property, and nowhere else.
      </p>
    </form>
  );
}
