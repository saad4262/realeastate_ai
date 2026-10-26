import Link from 'next/link';
import { can } from '@repo/core/permissions';
import {
  DOCUMENT_KIND_LABELS,
  documentStorageConfigured,
  KNOWLEDGE_KINDS,
  listDocuments,
  type DocumentKind,
} from '@repo/core/documents';
import { getConsoleDb } from '@/lib/db';
import { requireConsoleAccess } from '@/lib/require-console-access';
import { DocumentsPanel } from './documents-panel';
import styles from './documents.module.css';

/**
 * The agency knowledge base (ADR 0053, the brief's #11): procedures, policies, scripts and
 * templates the agency writes once, that every member reads and the assistant answers from.
 * Shared by `/knowledge` and `/my-knowledge` — one app, so one component. Everyone in the agency
 * reads it (`knowledge:read`); owners and admins add and remove (`knowledge:manage`).
 * The kind filter is in the URL, so Back and a shared link keep it.
 */
export async function KnowledgePage({
  surface,
  searchParams,
}: {
  surface: 'agency' | 'agent';
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess(surface);
  const actor = session.actor;
  const sp = await searchParams;
  const raw = Array.isArray(sp.kind) ? sp.kind[0] : sp.kind;
  const kind = (KNOWLEDGE_KINDS as readonly string[]).includes(raw ?? '') ? (raw as DocumentKind) : null;
  const basePath = surface === 'agency' ? '/knowledge' : '/my-knowledge';
  const agencyId = actor.agencyId ?? '';
  const mayManage = can(actor, 'knowledge:manage', { type: 'knowledge', agencyId });

  const all = await listDocuments(getConsoleDb(), actor, { on: 'knowledge' });
  const documents = kind ? all.filter((d) => d.kind === kind) : all;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.h1}>Knowledge base</h1>
        <p className={styles.sub}>
          The agency’s own procedures, policies, scripts and templates. Everyone in the agency can read them, and the assistant
          answers from them — ask it “what’s our process for an open home?” and it quotes the page.
        </p>
      </div>
      <nav className={styles.filters} aria-label="Filter by kind">
        <Link href={basePath} className={kind ? styles.filter : styles.filterOn} aria-current={kind ? undefined : 'page'}>
          All
        </Link>
        {KNOWLEDGE_KINDS.map((k) => (
          <Link key={k} href={`${basePath}?kind=${k}`} className={kind === k ? styles.filterOn : styles.filter} aria-current={kind === k ? 'page' : undefined}>
            {DOCUMENT_KIND_LABELS[k]}
          </Link>
        ))}
      </nav>
      <DocumentsPanel
        heading={kind ? `${DOCUMENT_KIND_LABELS[kind]} documents` : 'Everything in the knowledge base'}
        target={{ on: 'knowledge' }}
        documents={documents}
        mayUpload={mayManage}
        kinds={KNOWLEDGE_KINDS}
        defaultKind={kind ?? 'procedure'}
        allowPrivate={false}
        storageReady={documentStorageConfigured()}
        emptyTitle={kind ? 'Nothing of this kind yet' : 'The knowledge base is empty'}
        emptyHint={mayManage ? 'Add your procedures, policies and scripts above.' : 'An owner or admin adds the agency’s procedures and policies here.'}
        cannotUploadNote="Owners and admins add to the knowledge base. Everyone can read it."
      />
    </div>
  );
}
