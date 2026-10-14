import Link from 'next/link';
import { listTemplates, TEMPLATE_STATUS_LABELS, TemplateEmailError } from '@repo/core/template-email';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { TemplateForm, TemplateSteps } from './islands';

/** One template (ADR 0043): ready when saved; its author or an admin edits or retires it. */
export async function TemplatePage({ surface, id }: { surface: 'agency' | 'agent'; id: string | null }) {
  const session = await requireConsoleAccess(surface);
  const basePath = surface === 'agency' ? '/bulk-email' : '/my-bulk-email';
  const db = getConsoleDb();
  let list: Awaited<ReturnType<typeof listTemplates>>;
  try {
    list = await listTemplates(db, session.actor);
  } catch (err) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err instanceof TemplateEmailError ? err.message : 'Failed to load'}</p>;
  }
  const t = id ? list.templates.find((x) => x.id === id) : null;
  if (id && !t) return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>That template was not found</p>;

  return (
    <div className={contactStyles.wrap}>
      <Link href={basePath} className={contactStyles.back}>← Bulk email</Link>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{t ? t.name : 'New template'}</h1>
          <p className={contactStyles.sub}>
            {t
              ? `${TEMPLATE_STATUS_LABELS[t.status]} · ${t.agencyWide ? 'for everyone in the agency' : 'only its author sends it'}${t.authorName ? ` · written by ${t.authorName}` : ''}`
              : surface === 'agency'
                ? 'Ready to use as soon as you save it — for everyone in the agency.'
                : 'Ready to use as soon as you save it — for you only.'}
          </p>
        </div>
        {t ? <TemplateSteps id={t.id} mayRetire={t.mayRetire} /> : null}
      </div>
      <div className={contactStyles.card}>
        {!t || t.mayEdit ? (
          <TemplateForm basePath={basePath} {...(t ? { templateId: t.id, initial: { name: t.name, subject: t.subject, body: t.body } } : {})} />
        ) : (
          <div className={contactStyles.section} style={{ borderTop: 0 }}>
            <p className={contactStyles.note}>Subject</p>
            <p style={{ margin: 0, fontWeight: 600 }}>{t.subject}</p>
            <p className={contactStyles.note} style={{ marginTop: '0.75rem' }}>Email</p>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{t.body}</pre>
            <p className={contactStyles.hint} style={{ marginTop: '0.75rem' }}>
              Only its author or an owner/admin can change this template.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
