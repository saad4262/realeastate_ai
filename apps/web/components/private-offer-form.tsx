'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition, type FormEvent, type MouseEvent } from 'react';
import { sendPrivateOfferAction } from '../lib/offer-action';

/**
 * "Make a private offer" on a property nobody is currently selling.
 *
 * Deliberately behind a button rather than open on the page. An enquiry form
 * sitting open invites a question; an offer form sitting open invites a number,
 * and this is an unsolicited approach about somebody's home. Opening it is a
 * decision the visitor makes.
 *
 * ## No zod in here
 *
 * The same rule the enquiry form follows, for the same measured reason: pulling
 * the schema into this bundle cost 14 kB of First Load JS for rules the server
 * applies anyway. What is here is `required`, `min` and `maxLength` — enough to
 * catch a slip without a round trip. `privateOfferInputSchema` is the contract
 * and the server is where it is enforced.
 *
 * ## Signed out
 *
 * Shows a sign-in link in place of the form, not an error. The requirement is
 * that an offer be attributable to an account (docs/adr/0012), so being signed
 * out is an expected state on the way in rather than a failure — and the action
 * refuses independently, so this is a courtesy and not the control.
 */
/**
 * Asked for from elsewhere on the page — the sticky bar's "Make an offer".
 *
 * An event rather than lifted state, because the bar and this card sit in
 * different server-rendered branches and neither owns the other.
 */
const OPEN_EVENT = 'private-offer:open';

function scrollToOffer() {
  document.getElementById('offer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * The page-level "Make an offer" button.
 *
 * Was a plain `#offer` anchor, which scrolled to the card and left it closed —
 * and with the sidebar already in view it did not visibly do anything at all.
 * Still an <a href="#offer">, so with no JavaScript it at least scrolls.
 */
export function OfferLink({ className, children }: { className?: string; children: React.ReactNode }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    window.dispatchEvent(new Event(OPEN_EVENT));
  }
  return (
    <a href="#offer" onClick={onClick} className={className}>
      {children}
    </a>
  );
}

export function PrivateOfferForm({
  propertyId,
  propertyAddress,
  signedIn,
}: {
  propertyId: string;
  propertyAddress: string;
  signedIn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busy, start] = useTransition();

  // Opened by OfferLink, or by arriving on a `#offer` link. Scrolled to after
  // the render that opens it, so the visitor lands on the form, not above it.
  useEffect(() => {
    const open = () => {
      setOpen(true);
      requestAnimationFrame(scrollToOffer);
    };
    if (window.location.hash === '#offer') open();
    window.addEventListener(OPEN_EVENT, open);
    return () => window.removeEventListener(OPEN_EVENT, open);
  }, []);

  /**
   * `content-start` and `self-start`, both deliberately.
   *
   * A grid item stretches to its track by default, so in the property page's
   * right-hand column this card grew to the full height of the history beside
   * it and spread three lines of text across it — a card that was mostly empty
   * space with a sentence stranded at the bottom. `self-start` stops the card
   * growing; `content-start` stops its own rows spreading if it ever does.
   */
  const card =
    'grid content-start gap-sm self-start scroll-mt-xl rounded-lg ' +
    'border border-line-subtle bg-card p-lg shadow-card';

  if (sent) {
    return (
      <div id="offer" className={card}>
        <h2 className="text-headline-md font-display text-ink">Offer sent</h2>
        <p className="mt-1 text-body-md text-ink-soft">
          The agency that sold this property has your offer and your contact
          details. They will pass it on to the owner if the owner wants to hear
          it — an off-market offer is an approach, not a negotiation, and there
          may be no reply.
        </p>
      </div>
    );
  }

  /** Signed out, or the server said so after the fact. */
  if (!signedIn || needsSignIn) {
    return (
      <div id="offer" className={card}>
        <h2 className="text-headline-md font-display text-ink">Make a private offer</h2>
        <p className="mt-0.5 text-body-sm text-ink-soft">
          This property is not on the market. You can make a private offer to the
          agency that last sold it — sign in first, so the agency knows who the
          offer is from.
        </p>
        <Link
          href={`/login?next=${encodeURIComponent(`/property/${propertyId}`)}`}
          className="mt-1 inline-flex w-fit items-center justify-center rounded-md bg-brand px-lg py-sm text-body-md font-medium text-brand-ink transition hover:opacity-90"
        >
          Sign in to make an offer
        </Link>
      </div>
    );
  }

  if (!open) {
    return (
      <div id="offer" className={card}>
        <h2 className="text-headline-md font-display text-ink">Make a private offer</h2>
        <p className="mt-0.5 text-body-sm text-ink-soft">
          This property is not on the market. Your offer goes to the agency that
          last sold it, with your name and contact details.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-1 inline-flex w-fit items-center justify-center rounded-md bg-brand px-lg py-sm text-body-md font-medium text-brand-ink transition hover:opacity-90"
        >
          Make a private offer
        </button>
      </div>
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      name: String(data.get('name') ?? ''),
      phone: String(data.get('phone') ?? '') || undefined,
      message: String(data.get('message') ?? ''),
      /**
       * Commas and dollar signs stripped here, not on the server. People type
       * "$905,000" into a price field and the schema coerces with Number(),
       * which turns that into NaN and reports "enter your offer as a number" to
       * somebody who did.
       *
       * No email field: it comes from the session. See offer-schema.ts.
       */
      offerAmount: String(data.get('offerAmount') ?? '').replace(/[,$\s]/g, ''),
    };
    setError(null);

    start(async () => {
      const result = await sendPrivateOfferAction(propertyId, propertyAddress, input);
      if (result.ok) {
        setSent(true);
      } else if (result.needsSignIn) {
        setNeedsSignIn(true);
      } else {
        setError(result.error);
      }
    });
  }

  const field =
    'w-full rounded-md border border-line bg-canvas px-md py-sm text-body-md text-ink ' +
    'placeholder:text-ink-faint focus:border-brand focus:outline-none';

  return (
    <form id="offer" onSubmit={onSubmit} className={card}>
      <div>
        <h2 className="text-headline-md font-display text-ink">Make a private offer</h2>
        <p className="mt-0.5 text-body-sm text-ink-soft">
          For {propertyAddress}. Your offer and details go to the agency that
          last sold it.
        </p>
      </div>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Your offer (AUD)</span>
        <input
          name="offerAmount"
          type="text"
          inputMode="numeric"
          required
          autoComplete="off"
          placeholder="905,000"
          className={field}
        />
        <span className="text-body-sm text-ink-faint">
          Whole dollars. The agency sees this figure exactly as you enter it.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="text-label-md uppercase text-ink-faint">Name</span>
        <input name="name" required minLength={2} maxLength={120} autoComplete="name" className={field} />
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
          defaultValue="I would like to make a private offer on this property."
          className={`${field} resize-y`}
        />
      </label>

      {error ? (
        <p role="alert" className="text-body-sm text-alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-sm">
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-brand px-lg py-sm text-body-md font-medium text-brand-ink transition hover:opacity-90 disabled:opacity-60"
        >
          {busy ? 'Sending…' : 'Send private offer'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-md border border-line px-lg py-sm text-body-md font-medium text-ink-soft transition hover:border-line-strong hover:text-ink disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
