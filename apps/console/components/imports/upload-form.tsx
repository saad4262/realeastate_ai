'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { uploadImportAction } from '@/lib/import-actions';

export function UploadForm({ base, mayPublish }: { base: string; mayPublish: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const r = await uploadImportAction(form);
          if (!r.ok) setError(r.error);
          else {
            if (r.sameFileAs) alert(`You uploaded this same file on ${new Date(r.sameFileAs).toLocaleDateString('en-AU')}. The check will show its rows as duplicates.`);
            router.push(`${base}/${r.id}`);
          }
        });
      }}
      style={{ display: 'grid', gap: '0.75rem', maxWidth: '32rem' }}
    >
      <label>
        CSV file (UTF-8, up to 10 MB)
        <input type="file" name="file" accept=".csv,text/csv" required style={{ display: 'block', marginTop: '0.25rem' }} />
      </label>
      {mayPublish ? (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Imported listings should be</legend>
          <label style={{ marginRight: '1rem' }}>
            <input type="radio" name="mode" value="live" defaultChecked /> as in the file (live, under offer, sold…)
          </label>
          <label>
            <input type="radio" name="mode" value="draft" /> drafts, for me to publish later
          </label>
        </fieldset>
      ) : null}
      {error ? <p role="alert" style={{ color: 'var(--rose)', margin: 0 }}>{error}</p> : null}
      <button type="submit" disabled={pending} style={{ justifySelf: 'start', padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 0, background: 'var(--sapphire)', color: '#fff', fontWeight: 600 }}>
        {pending ? 'Uploading…' : 'Upload and match columns'}
      </button>
    </form>
  );
}
