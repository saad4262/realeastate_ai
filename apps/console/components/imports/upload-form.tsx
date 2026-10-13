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
        const file = form.get('file');
        // Checked here too: a body over the server's limit never reaches the action to be refused politely.
        if (file instanceof File && file.size > 4 * 1024 * 1024) {
          setError('That file is larger than 4 MB. Split it into smaller files, or import it from Google Sheets.');
          return;
        }
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
        CSV (UTF-8) or Excel (.xlsx) file, up to 4 MB
        <input
          type="file"
          name="file"
          accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          style={{ display: 'block', marginTop: '0.25rem' }}
        />
      </label>
      <label>
        Excel sheet name <span style={{ color: 'var(--text-secondary)' }}>(only for a workbook with several sheets — otherwise the first one with rows)</span>
        <input type="text" name="sheet" maxLength={100} placeholder="e.g. Listings" style={{ display: 'block', marginTop: '0.25rem' }} />
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
