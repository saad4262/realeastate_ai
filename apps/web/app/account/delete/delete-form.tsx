'use client';

import { useState, useTransition } from 'react';
import { deleteAccountAction } from './actions';
import styles from '../account.module.css';

export function DeleteAccountForm({ email }: { email: string }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await deleteAccountAction(typed);
          setError(r.error);
        });
      }}
    >
      <label htmlFor="confirm-email" className={styles.body}>
        Type <strong>{email}</strong> to confirm.
      </label>
      <input
        id="confirm-email"
        type="email"
        autoComplete="off"
        required
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        className="rounded-md border border-line bg-canvas px-3 py-2 text-ink"
      />
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <div>
        <button type="submit" className={styles.danger} disabled={pending || typed.trim().toLowerCase() !== email.toLowerCase()}>
          {pending ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </form>
  );
}
