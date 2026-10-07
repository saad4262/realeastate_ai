'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { assignNeedsOwnerAction } from '@/lib/offboarding-actions';

export function AssignOwner({ kind, id, members }: { kind: string; id: string; members: { userId: string; name: string }[] }) {
  const router = useRouter();
  const [who, setWho] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
      <select value={who} onChange={(e) => setWho(e.target.value)} disabled={pending}>
        <option value="">Give to…</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!who || pending}
        onClick={() =>
          start(async () => {
            const r = await assignNeedsOwnerAction(kind, id, who);
            if (!r.ok) return setError(r.error);
            router.refresh();
          })
        }
      >
        Assign
      </button>
      {error ? <span role="alert" style={{ color: 'var(--rose)', fontSize: '0.75rem' }}>{error}</span> : null}
    </span>
  );
}
