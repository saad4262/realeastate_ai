'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './mark-sold-dialog.module.css';

/**
 * What an agency has to say to record a sale.
 *
 * A dialog rather than an inline button, because unlike publish and withdraw
 * this transition CARRIES DATA and is the one that cannot be shrugged off: the
 * price becomes a permanent line in the public history of the address, and
 * `deleteListing` then refuses to remove the listing holding it. A click that
 * does that should cost a sentence of reading.
 *
 * ## It does not validate the numbers itself
 *
 * `soldDetailsSchema` in packages/core is the contract, and the server parses
 * against it on every call. What is here is the browser's own cheap pass —
 * `required`, `min`, `max` on the inputs — so an obvious slip is caught without
 * a round trip. The zod schema is deliberately NOT imported: doing that on the
 * enquiry form cost 14 kB of First Load JS for rules the server applies anyway.
 *
 * The `max` on the date is today, which is the same rule the schema states
 * ("a sale cannot be dated in the future"). Two places say it, and only one of
 * them is authoritative — the input is a courtesy, the refusal is the server's.
 */
export type SoldDraft = { soldPrice: number; soldDate: string };

export function MarkSoldDialog({
  address,
  priceHint,
  busy,
  onCancel,
  onConfirm,
}: {
  address: string;
  /** What the ad asked, as a starting point. Never prefilled — see below. */
  priceHint?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (draft: SoldDraft) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  /** Today, in the yyyy-mm-dd the date input wants, in the browser's own zone. */
  const today = new Date();
  const maxDate = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');

  useEffect(() => {
    priceRef.current?.focus();
  }, []);

  /** Escape closes it. A dialog that traps you is worse than no dialog. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const price = Number(String(data.get('soldPrice') ?? '').replace(/[,$\s]/g, ''));
    const date = String(data.get('soldDate') ?? '');

    if (!Number.isFinite(price) || price < 1) {
      setError('Enter what the property sold for.');
      return;
    }
    if (!date) {
      setError('Enter the date of the sale.');
      return;
    }

    setError(null);
    onConfirm({ soldPrice: Math.round(price), soldDate: date });
  }

  return (
    <div
      className={styles.backdrop}
      /**
       * Clicking the backdrop cancels, but only the backdrop — the check stops a
       * click that started inside the panel and drifted out from closing it and
       * throwing away what was typed.
       */
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mark-sold-title"
      >
        <h2 id="mark-sold-title" className={styles.title}>
          Record a sale
        </h2>
        <p className={styles.addr}>{address}</p>

        <p className={styles.consequence}>
          This takes the listing off the public site and starts the property&rsquo;s
          public sale history. The figure you enter is shown to anyone who opens
          that address once it is no longer on the market.
        </p>

        <form onSubmit={submit} noValidate>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label htmlFor="soldPrice">Sold price</label>
              <input
                ref={priceRef}
                id="soldPrice"
                name="soldPrice"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="812000"
                className={`${styles.input} ${error ? styles.invalid : ''}`}
                required
              />
              <span className={styles.hint}>
                {priceHint ? `The ad asked ${priceHint}.` : 'Whole dollars.'}
              </span>
            </div>

            <div className={styles.field}>
              <label htmlFor="soldDate">Date of sale</label>
              <input
                id="soldDate"
                name="soldDate"
                type="date"
                max={maxDate}
                className={styles.input}
                required
              />
            </div>
          </div>

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}

          <div className={styles.footer}>
            <button type="button" className={styles.cancel} onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={styles.confirm} disabled={busy}>
              Record the sale
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
