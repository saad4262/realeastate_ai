import Link from 'next/link';
import contactStyles from '@/components/contacts/contacts.module.css';

/** Settings. Integrations is the first section that exists; offices and preferences come later. */
export default function SettingsPage() {
  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>Settings</h1>
        <p className={contactStyles.sub}>Agency preferences. More sections arrive as they are built.</p>
      </div>
      <div className={contactStyles.card}>
        <div className={contactStyles.section} style={{ borderTop: 0 }}>
          <Link href="/settings/integrations" className={contactStyles.name}>Integrations →</Link>
          <p className={contactStyles.note}>Google Calendar, Zoom, Google Sheets and Google reviews.</p>
        </div>
        <div className={contactStyles.section}>
          <Link href="/settings/reviews" className={contactStyles.name}>Google reviews →</Link>
          <p className={contactStyles.note}>Find your agency’s Google listing; its rating and reviews show on your live listings.</p>
        </div>
      </div>
    </div>
  );
}
