import Link from 'next/link';
import { listTemplates, TEMPLATE_STATUS_LABELS, TemplateEmailError } from '@repo/core/template-email';
import { can } from '@repo/core/permissions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { TemplateForm, TemplateSteps } from './islands';

/** One template: edit while a draft, submit, and (admins) approve / send back / retire. */
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
  const mayRetire = Boolean(t) && t!.status !== 'retired' && can(session.actor, 'email_template:approve', { type: 'email_template', agencyId: session.actor.agencyId });

  return (
    <div className={contactStyles.wrap}>
      <Link href={basePath} className={contactStyles.back}>← Bulk email</Link>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>{t ? t.name : 'New template'}</h1>
          <p className={contactStyles.sub}>
            {t
              ? `${TEMPLATE_STATUS_LABELS[t.status]}${t.authorName ? ` · written by ${t.authorName}` : ''}${t.approvedByName ? ` · approved by ${t.approvedByName}` : ''}`
              : 'Agents draft; an owner or admin approves. Only an approved template can be sent.'}
          </p>
        </div>
        {t ? <TemplateSteps id={t.id} maySubmit={t.maySubmit} mayApprove={t.mayApprove} mayRetire={mayRetire} /> : null}
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
              {t.status === 'approved' ? 'Approved templates are not edited — retire it and write a new one.' : 'Waiting for an owner or admin.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
