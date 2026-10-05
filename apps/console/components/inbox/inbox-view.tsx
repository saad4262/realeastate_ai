import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import type { LeadAssignee, LeadKind } from '@repo/core/leads';
import {
  EMAIL_FRAME_SANDBOX,
  sandboxedEmailDocument,
  snippet,
  stripQuotedReply,
  type MailFolder,
  type MailMessageView,
  type MailThreadPage,
  type MailThreadRow,
  type MailThreadView,
} from '@repo/core/mail';
import { LeadAssignControl, LeadStatusControl } from '../lead-triage';
import { Composer } from './composer';
import { LinkPending, MailSync, MarkRead, RetrySend } from './islands';
import styles from './inbox.module.css';

/**
 * The console inbox (docs/adr/0016), laid out like a mail client rather than a
 * chat: a full-width list of conversations; opening one replaces the list with
 * the conversation, each message a full-width card — sender, recipient, date,
 * then the body — with older messages folded to one line. A Server Component;
 * the composer, the read marker and the retry button are the only islands, and
 * the folding is `<details>`, so it costs no JavaScript.
 *
 * The URL holds the state (`?folder=`, `?thread=`), so Back returns to the
 * list and a conversation can be linked from an email.
 *
 * Every "may" here (Offers folder, agency mailbox, composer, pickers) arrives
 * decided by can() in packages/core. Nothing here looks at a role (#2).
 */

const KIND_LABEL: Record<LeadKind, string> = {
  enquiry: 'Enquiry',
  inspection: 'Inspection',
  appraisal: 'Appraisal',
  offer: 'Offer',
};

function initial(name: string): string {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

export type InboxViewProps = {
  basePath: string;
  folder: MailFolder;
  page: MailThreadPage;
  /** The open conversation, a refusal to show it, or nothing chosen. */
  thread: { ok: true; view: MailThreadView; unread: boolean } | { ok: false; error: string } | null;
  assignees: LeadAssignee[];
  /** The agency's own address when inbound is set up; null when it is not. */
  agencyAddress: string | null;
  inboundOn: boolean;
  /** The consumer site's origin, for the property link. */
  webUrl: string;
};

function hrefFor(basePath: string, folder: MailFolder, threadId?: string): string {
  const params = new URLSearchParams();
  if (folder !== 'all') params.set('folder', folder);
  if (threadId) params.set('thread', threadId);
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function InboxView(props: InboxViewProps) {
  const { basePath, folder, page, thread } = props;

  const folders: { key: MailFolder; label: string }[] = [
    { key: 'all', label: 'Inbox' },
    { key: 'unread', label: 'Unread' },
    { key: 'mine', label: 'Assigned to me' },
    // Drawn only when can() said yes: an empty "Offers" folder shown to someone
    // who may not read one would announce that offers exist.
    ...(page.folders.offers ? [{ key: 'offers' as const, label: 'Offers' }] : []),
    ...(page.folders.general ? [{ key: 'general' as const, label: 'Agency mailbox' }] : []),
  ];

  return (
    <div className={styles.wrap}>
      <MailSync />
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Inbox</h1>
          <p className={styles.sub}>
            Every email with the people who have contacted you. Replies sent from Gmail or any
            other mail app land here too.
          </p>
        </div>
        {props.agencyAddress ? (
          <p className={styles.sub}>
            Your agency address: <span className={styles.address}>{props.agencyAddress}</span>
          </p>
        ) : null}
      </div>

      {!props.inboundOn ? (
        <p className={styles.banner} role="note">
          Replies from buyers are not coming back into this inbox yet — inbound mail is not set up
          on this server, so they go to the agent&apos;s own email instead. Setup: docs/DEPLOY.md →
          “Email conversations”.
        </p>
      ) : null}

      <nav className={styles.folders} aria-label="Folders">
        {folders.map((f) => (
          <Link
            key={f.key}
            href={hrefFor(basePath, f.key)}
            className={`${styles.folder} ${folder === f.key ? styles.folderOn : ''}`}
            aria-current={folder === f.key ? 'page' : undefined}
          >
            {f.label}
            {folder === f.key && page.counts.unread > 0 ? (
              <span className={styles.count} aria-label={`${page.counts.unread} unread`}>
                {page.counts.unread}
              </span>
            ) : null}
            <LinkPending />
          </Link>
        ))}
      </nav>

      <section className={styles.card} aria-label={thread ? 'Conversation' : 'Conversations'}>
        {thread === null ? (
          <ThreadList
            rows={page.rows}
            threadHref={(id) => hrefFor(basePath, folder, id)}
            emptyTitle={folder === 'unread' ? 'All caught up' : 'No conversations here'}
            emptyHint={
              folder === 'general'
                ? 'Email sent straight to your agency address lands here.'
                : 'Every enquiry starts a conversation, and replies to it collect here.'
            }
          />
        ) : !thread.ok ? (
          <>
            <div className={styles.toolbar}>
              <Link href={hrefFor(basePath, folder)} className={styles.back}>
                ← Inbox
              </Link>
            </div>
            <p className={styles.alert} role="alert">
              {thread.error}
            </p>
          </>
        ) : (
          <ThreadReader
            view={thread.view}
            unread={thread.unread}
            backHref={hrefFor(basePath, folder)}
            assignees={props.assignees}
            inboundOn={props.inboundOn}
            webUrl={props.webUrl}
          />
        )}
      </section>
    </div>
  );
}

/**
 * The list of conversations. Exported for the contact profile's Emails tab
 * (ADR 0018), which shows one person's threads with the same rows; where a row
 * opens is the caller's (`threadHref`), so each screen keeps its own URLs.
 */
export function ThreadList({
  rows,
  threadHref,
  emptyTitle,
  emptyHint,
}: {
  rows: MailThreadRow[];
  threadHref: (threadId: string) => string;
  emptyTitle: string;
  emptyHint: string;
}) {
  if (rows.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>{emptyTitle}</p>
        <p className={styles.emptyHint}>{emptyHint}</p>
      </div>
    );
  }

  return (
    <ul className={styles.list}>
      {rows.map((r) => (
        <li key={r.id} className={styles.item}>
          <Link href={threadHref(r.id)} className={`${styles.row} ${r.unread ? styles.unread : ''}`}>
            {r.unread ? <span className={styles.dot} aria-label="Unread" /> : <span className={styles.noDot} />}
            <span className={styles.sender}>{r.contactName || r.contactEmail}</span>
            <span className={styles.line}>
              {r.leadKind ? (
                <span className={`${styles.badge} ${r.leadKind === 'offer' ? styles.badgeOffer : ''}`}>
                  {KIND_LABEL[r.leadKind]}
                </span>
              ) : (
                <span className={`${styles.badge} ${styles.badgeMail}`}>Email</span>
              )}
              {r.leadStatus === 'new' ? <span className={`${styles.badge} ${styles.badgeNew}`}>New</span> : null}
              <span className={styles.subject}>{r.subject}</span>
              {r.preview ? (
                <span className={styles.snippet}>
                  {' — '}
                  {r.lastFromUs ? 'You: ' : ''}
                  {r.preview}
                </span>
              ) : null}
              {r.assigneeName ? <span className={styles.badge}>{r.assigneeName}</span> : null}
            </span>
            <time className={styles.time} dateTime={r.lastMessageAt.toISOString()}>
              <LocalTime iso={r.lastMessageAt.toISOString()} style="short" />
              <LinkPending />
            </time>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** One conversation. Exported for the contact profile's Emails tab, like ThreadList. */
export function ThreadReader({
  view,
  unread,
  backHref,
  backLabel = '← Inbox',
  assignees,
  inboundOn,
  webUrl,
}: {
  view: MailThreadView;
  unread: boolean;
  backHref: string;
  backLabel?: string;
  assignees: LeadAssignee[];
  inboundOn: boolean;
  webUrl: string;
}) {
  const contact = view.contactName || view.contactEmail;
  const lead = view.lead;

  // Everything in order, the form message first. Older messages fold to one
  // line the way a mail client shows a long thread; the newest stays open.
  const items: ({ kind: 'opening' } | { kind: 'mail'; m: MailMessageView })[] = [
    ...(lead?.message ? [{ kind: 'opening' as const }] : []),
    ...view.messages.map((m) => ({ kind: 'mail' as const, m })),
  ];
  const openFrom = items.length <= 3 ? 0 : items.length - 1;

  return (
    <div>
      <MarkRead threadId={view.id} unread={unread} />

      <div className={styles.toolbar}>
        <Link href={backHref} className={styles.back}>
          {backLabel}
        </Link>
      </div>

      <header className={styles.threadHead}>
        <div className={styles.threadTitle}>
          <h2 className={styles.readerTitle}>{view.subject}</h2>
          {lead ? (
            <span className={`${styles.badge} ${lead.kind === 'offer' ? styles.badgeOffer : ''}`}>
              {KIND_LABEL[lead.kind]}
            </span>
          ) : (
            <span className={`${styles.badge} ${styles.badgeMail}`}>Agency mailbox</span>
          )}
        </div>
        {lead ? (
          <div className={styles.controls}>
            <span className={styles.control}>
              Status
              <LeadStatusControl leadId={lead.id} status={lead.status} mayUpdate={view.mayUpdateLead} />
            </span>
            <span className={styles.control}>
              Assigned to
              <LeadAssignControl
                leadId={lead.id}
                kind={lead.kind}
                assignedTo={lead.assignedTo}
                assigneeName={lead.assigneeName}
                assignees={view.mayAssignLead ? assignees : []}
              />
            </span>
            {lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : null}
            <a
              href={
                lead.kind === 'offer' || !lead.listingId
                  ? `${webUrl}/property/${lead.propertyId}`
                  : `${webUrl}/listing/${lead.listingId}`
              }
              target="_blank"
              rel="noopener"
              aria-label={`${lead.address} (opens the public page in a new tab)`}
            >
              {lead.address} ↗
            </a>
          </div>
        ) : null}
      </header>

      <div className={styles.messages}>
        {items.map((item, i) =>
          item.kind === 'opening' && lead?.message ? (
            <MessageCard
              key="opening"
              open={i >= openFrom}
              fromName={contact}
              fromEmail={view.contactEmail}
              toLine={`to your agency · via the ${lead.kind === 'offer' ? 'offer' : 'enquiry'} form`}
              when={lead.createdAt}
              us={false}
              preview={snippet(lead.message)}
            >
              <div className={styles.bodyText}>{lead.message}</div>
            </MessageCard>
          ) : item.kind === 'mail' ? (
            <Message key={item.m.id} m={item.m} contact={contact} contactEmail={view.contactEmail} open={i >= openFrom} />
          ) : null,
        )}
        {items.length === 0 ? <p className={styles.alert}>No messages yet.</p> : null}
      </div>

      {view.maySend ? (
        <Composer
          threadId={view.id}
          to={view.contactName ? `${view.contactName} <${view.contactEmail}>` : view.contactEmail}
          replyNote={
            inboundOn
              ? `When ${contact} replies, it comes back to this conversation.`
              : `Until inbound mail is set up, ${contact}'s email replies go to your own email.`
          }
        />
      ) : (
        <p className={styles.readonly}>You can read this conversation, but replying is up to whoever it is assigned to.</p>
      )}
    </div>
  );
}

/** One message as a mail client shows it. Folded to one line when `open` is false. */
function MessageCard({
  open,
  fromName,
  fromEmail,
  toLine,
  when,
  us,
  preview,
  extra,
  children,
}: {
  open: boolean;
  fromName: string;
  fromEmail: string | null;
  toLine: string;
  when: Date;
  us: boolean;
  preview: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details className={styles.message} open={open}>
      <summary className={styles.messageHead}>
        <span className={`${styles.avatar} ${us ? styles.avatarUs : ''}`} aria-hidden>
          {initial(fromName)}
        </span>
        <span className={styles.who}>
          <span className={styles.fromLine}>
            <span className={styles.fromName}>{fromName}</span>
            {fromEmail ? <span className={styles.fromEmail}>&lt;{fromEmail}&gt;</span> : null}
            {extra}
          </span>
          <span className={styles.toLine}>{toLine}</span>
          <span className={styles.collapsedSnippet}>{preview}</span>
        </span>
        <time className={styles.when} dateTime={when.toISOString()}>
          <LocalTime iso={when.toISOString()} />
        </time>
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}

function Message({
  m,
  contact,
  contactEmail,
  open,
}: {
  m: MailMessageView;
  contact: string;
  contactEmail: string;
  open: boolean;
}) {
  const out = m.direction === 'out';
  const fromName = out ? m.authorName || 'Your agency' : m.fromName || m.fromEmail || contact;
  const shown = out ? m.text : stripQuotedReply(m.text);
  const quoted = !out && shown.length < m.text.trim().length;

  return (
    <MessageCard
      open={open}
      fromName={fromName}
      fromEmail={out ? null : m.fromEmail}
      toLine={out ? `to ${contact} <${contactEmail}>` : 'to your agency'}
      when={m.createdAt}
      us={out}
      preview={snippet(m.text)}
      extra={
        out && m.channel === 'email' ? (
          <span className={styles.tag}>replied by email</span>
        ) : !out && m.channel === 'website' ? (
          <span className={styles.tag}>sent from the website</span>
        ) : null
      }
    >
      <div className={styles.bodyText}>{shown || <span className={styles.note}>(no text)</span>}</div>

      {quoted ? (
        <details className={styles.more}>
          <summary>Show quoted text</summary>
          <div className={styles.quoted}>{m.text}</div>
        </details>
      ) : null}

      {/*
        The email as it was formatted, in a sandbox with no scripts, no
        same-origin and a policy that blocks every remote fetch — see
        packages/core/src/mail/sandbox.ts. Closed by default: the text above is
        the reading copy.
      */}
      {!out && m.html ? (
        <details className={styles.more}>
          <summary>View original formatting</summary>
          <iframe
            className={styles.frame}
            title={`Email from ${fromName}`}
            sandbox={EMAIL_FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            loading="lazy"
            srcDoc={sandboxedEmailDocument(m.html)}
          />
        </details>
      ) : null}

      {m.attachments.length > 0 ? (
        <div className={styles.files}>
          {m.attachments.map((a, i) => (
            <span key={`${a.filename}-${i}`} className={styles.file} title="Attachments are listed but not kept yet">
              📎 {a.filename}
            </span>
          ))}
        </div>
      ) : null}

      {out && m.status === 'queued' ? <span className={styles.note}>Sending…</span> : null}
      {out && m.status === 'failed' ? (
        <span className={styles.noteError}>
          Not delivered. <RetrySend messageId={m.id} />
        </span>
      ) : null}
      {!out && m.error ? <span className={styles.noteWarn}>{m.error}</span> : null}
    </MessageCard>
  );
}
