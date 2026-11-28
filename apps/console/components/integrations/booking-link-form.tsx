'use client';

import { useState, useTransition } from 'react';
import { useToast } from '@/components/toast';
import { setBookingLinkAction } from '@/lib/integration-actions';
import contactStyles from '@/components/contacts/contacts.module.css';

/** ADR 0107: this person's booking page — what `{{booking_link}}` in a template gives the people they look after. */
export function BookingLinkForm({ initial, mayEdit }: { initial: string | null; mayEdit: boolean }) {
  const { toast } = useToast();
  const [value, setValue] = useState(initial ?? '');
  const [pending, start] = useTransition();
  return (
    <form
      style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setBookingLinkAction(value);
          if (!r.ok) toast({ title: 'Not saved', description: r.error, variant: 'error' });
          else {
            setValue(r.url ?? '');
            toast({ title: r.url ? 'Booking link saved' : 'Booking link removed' });
          }
        });
      }}
    >
      <input
        className={contactStyles.input}
        style={{ flex: '1 1 18rem', minWidth: 0 }}
        type="url"
        inputMode="url"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://calendly.com/your-name"
        aria-label="Your booking link"
        disabled={!mayEdit}
        maxLength={300}
      />
      {mayEdit ? (
        <button type="submit" className={contactStyles.btn} disabled={pending || value.trim() === (initial ?? '')}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      ) : null}
    </form>
  );
}
