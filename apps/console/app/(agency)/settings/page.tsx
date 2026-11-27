import Link from 'next/link';
import contactStyles from '@/components/contacts/contacts.module.css';

/** Settings. Connectors is the first section that exists; offices and preferences come later. */
export default function SettingsPage() {
  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>Settings</h1>
        <p className={contactStyles.sub}>Agency preferences. More sections arrive as they are built.</p>
      </div>
      <div className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <Link href="/settings/integrations" className={contactStyles.name}>Connectors →</Link>
          <p className={contactStyles.note}>Google Calendar, Zoom, Google Sheets and Google reviews.</p>
        </div>
        <div className={contactStyles.section}>
          <Link href="/settings/reviews" className={contactStyles.name}>Google reviews →</Link>
          <p className={contactStyles.note}>Find your agency’s Google listing; its rating and reviews show on your live listings.</p>
        </div>
        <div className={contactStyles.section}>
          <Link href="/settings/audit" className={contactStyles.name}>Audit log →</Link>
          <p className={contactStyles.note}>Who changed the team, sent invites, deleted listings or resumed sends, and when. Owners and admins.</p>
        </div>
        <div className={contactStyles.section}>
          <Link href="/settings/data" className={contactStyles.name}>Download your data →</Link>
          <p className={contactStyles.note}>Everything in the agency as spreadsheets, with the photos and documents, in zip files. Kept 24 hours.</p>
        </div>
      </div>
    </div>
  );
}
