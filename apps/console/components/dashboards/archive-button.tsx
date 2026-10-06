'use client';

import { useTransition } from 'react';
import { archiveDashboardAction } from '@/lib/dashboard-actions';

export function ArchiveDashboardButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (confirm('Remove this dashboard? Its link will stop working.')) start(async () => void (await archiveDashboardAction(id)));
      }}
      style={{ border: '1px solid var(--border-default)', borderRadius: '0.375rem', background: 'transparent', padding: '0.25rem 0.625rem', cursor: 'pointer' }}
    >
      {pending ? 'Removing…' : 'Remove'}
    </button>
  );
}
