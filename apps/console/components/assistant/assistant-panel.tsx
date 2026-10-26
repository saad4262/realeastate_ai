'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AssistantFrame } from '@repo/core/assistant/schema';
import {
  approveProposedActionAction,
  cancelProposedActionAction,
  getProposedActionAction,
  rejectProposedActionAction,
} from '@/lib/assistant-actions';
import type { ProposalView } from '@repo/core/assistant';
import type { Turn } from './use-assistant';
import { Tile } from '../dashboards/tile';
import { RichText } from './rich-text';
import { UploadForm } from '../imports/upload-form';
import { SheetImport } from '../imports/sheet-import';
import styles from './assistant-panel.module.css';

/**
 * The console assistant's conversation parts (docs/adr/0025): the turns, the
 * frames beside an answer and the proposal cards. Both consoles show them on
 * their assistant home (assistant-home.tsx) — it was a floating panel once,
 * which is where this file's name comes from.
 *
 * Everything listed beside an answer is a frame the server built from SQL —
 * names, dates, counts and links never come from the model's prose. The
 * model's words are labelled as the assistant's (#7 scope: they reach only
 * the person who asked).
 */

export type Surface = 'agent' | 'agency';

const PATHS: Record<Surface, { contact: string; leads: string; templates: string; bulk: string; integrations: string; inbox: string; messages: string; listings: string; listingImport: string; contactImport: string; skills: string; workflows: string; knowledge: string }> = {
  agency: { contact: '/customers', leads: '/leads', templates: '/bulk-email/templates', bulk: '/bulk-email', integrations: '/settings/integrations', inbox: '/inbox', messages: '/messages', listings: '/live-listings', listingImport: '/live-listings/import', contactImport: '/customers/import', skills: '/skills', workflows: '/workflows', knowledge: '/knowledge' },
  agent: { contact: '/my-contacts', leads: '/my-leads', templates: '/my-bulk-email/templates', bulk: '/my-bulk-email', integrations: '/my-integrations', inbox: '/my-inbox', messages: '/my-messages', listings: '/listings', listingImport: '/listings/import', contactImport: '/my-contacts/import', skills: '/my-skills', workflows: '/my-workflows', knowledge: '/my-knowledge' },
};

/** What the empty assistant suggests — the home turns the ones you can type into chips. */
export const EXAMPLES = [
  '“Which leads came in this week?”',
  '“What’s on my calendar tomorrow?”',
  '“Is my Google Calendar connected?”',
  '“Book an appraisal with this contact tomorrow at 3pm.”',
  'Pick contacts in the directory, then: “Send them the open home template.”',
  '“What’s our sold value this month?” (owners and admins)',
];

/** The conversation itself: what was asked, the labelled answer, and the server's frames. */
export function TurnList({ turns, surface }: { turns: Turn[]; surface: Surface }) {
  return (
    <>
      {turns.map((t) => (
        <div key={t.key} className={styles.turn}>
          <div className={styles.you}>{t.userText}</div>
          {t.answer ? (
            <div className={styles.answer}>
              <div className={styles.label}>Written by the assistant</div>
              <RichText text={t.answer} />
            </div>
          ) : null}
          {t.frames.map((f, i) => (
            <FrameView key={i} frame={f} surface={surface} />
          ))}
          {t.pending && !t.error ? <div className={styles.status}>{t.status ?? 'Thinking…'}</div> : null}
          {t.error ? (
            <div className={styles.error} role="alert">
              {t.error}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

function FrameView({ frame, surface }: { frame: AssistantFrame; surface: Surface }) {
  const p = PATHS[surface];
  switch (frame.kind) {
    case 'contacts':
      return (
        <FrameBox title="Contacts" total={frame.total} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              <Link href={`${p.contact}/${r.id}`}>{r.name}</Link>
              <span className={styles.meta}>
                {[r.roles.join(', '), r.assigneeName ? `assigned to ${r.assigneeName}` : 'unassigned', r.archived ? 'archived' : ''].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </FrameBox>
      );
    case 'leads':
      return (
        <FrameBox title="Leads" total={frame.total} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              {r.contactId ? <Link href={`${p.contact}/${r.contactId}`}>{r.name}</Link> : <Link href={p.leads}>{r.name}</Link>}
              <span className={styles.meta}>
                {r.address} · {r.status} · {r.received}
              </span>
            </li>
          ))}
        </FrameBox>
      );
    case 'appointments':
      return (
        <FrameBox title="Appointments" total={frame.total} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              <Link href={`${p.contact}/${r.contactId}`}>{r.title}</Link>
              <span className={styles.meta}>
                {r.when} · {r.contactName} · {r.status}
              </span>
            </li>
          ))}
        </FrameBox>
      );
    case 'templates':
      return (
        <FrameBox title="Approved templates" total={frame.total} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              <Link href={`${p.templates}/${r.id}`}>{r.name}</Link>
              <span className={styles.meta}>{r.subject}</span>
            </li>
          ))}
        </FrameBox>
      );
    case 'search':
      return (
        <FrameBox title={frame.mode === 'hybrid' ? 'Found in notes and emails (words and meaning)' : 'Found in notes and emails'} shown={frame.rows.length}>
          {frame.rows.map((r, i) => (
            <li key={`${r.contactId}-${i}`}>
              <Link href={`${p.contact}/${r.contactId}`}>{r.contactName}</Link>
              <span className={styles.meta}>
                {r.type === 'note' ? 'Note' : r.type === 'email' ? 'Email' : 'Enquiry'} · {r.when}
              </span>
              {r.snippet ? <q className={styles.meta}>{r.snippet}</q> : null}
            </li>
          ))}
        </FrameBox>
      );
    case 'documents':
      // ADR 0053: the title opens the file (the same visibility rule, asked again by the route); where it is kept links to that page.
      return (
        <FrameBox title={frame.mode === 'hybrid' ? 'Found in documents (words and meaning)' : 'Found in documents'} shown={frame.rows.length}>
          {frame.rows.map((r) => (
            <li key={r.id}>
              <a href={`/api/documents/${r.id}`} target="_blank" rel="noopener">
                {r.title}
              </a>
              <span className={styles.meta}>
                {r.pages} ·{' '}
                {r.scope === 'knowledge' ? (
                  <Link href={p.knowledge}>Knowledge base</Link>
                ) : r.contactId ? (
                  <Link href={`${p.contact}/${r.contactId}?tab=documents`}>{r.contactName ?? 'Contact'}</Link>
                ) : (
                  'A listing'
                )}
              </span>
              {r.snippet ? <q className={styles.meta}>{r.snippet}</q> : null}
            </li>
          ))}
        </FrameBox>
      );
    case 'proposal':
      return <ProposalCardView id={frame.id} surface={surface} />;
    case 'widget':
      // An open answer (ADR 0042) is the answer itself — its rows, how it was worked out — so it is drawn in full.
      return <Tile tile={frame.tile} compact={!(frame.tile.state === 'ok' && frame.tile.data.kind === 'open')} />;
    case 'import': {
      // The import's own controls (ADR 0039 Phase 3): the file and the sheet go to the import screens, never to the model.
      const base = frame.what === 'contacts' ? p.contactImport : p.listingImport;
      return (
        <div className={styles.frame}>
          <div className={styles.frameHead}>{frame.what === 'contacts' ? 'Import contacts' : 'Import listings'}</div>
          <div style={{ padding: '0.625rem', display: 'grid', gap: '1rem' }}>
            <UploadForm base={base} mayPublish={frame.mayPublish} kind={frame.what} />
            <div>
              <div className={styles.label}>Or a Google Sheet</div>
              {frame.sheets.state === 'connected' ? null : <ConnectButton label="Google Sheets" mayConnect={frame.sheets.mayConnect} href={p.integrations} />}
              <SheetImport base={base} mayPublish={frame.mayPublish} kind={frame.what} integrationsHref={p.integrations} />
            </div>
            <Link href={base} className={styles.meta}>
              Open the import page
            </Link>
          </div>
        </div>
      );
    }
    case 'connections':
      return (
        <FrameBox title="Connected accounts">
          {frame.rows.map((r) => (
            <li key={r.provider}>
              <span>{r.label}</span>
              <span className={styles.meta}>
                {r.state === 'connected' ? `Connected${r.whose === 'agency' ? ' (agency)' : ''}` : `Not usable (${r.state.replace('_', ' ')})`}
              </span>
              {r.state === 'connected' ? null : <ConnectButton label={r.label} mayConnect={r.mayConnect} href={p.integrations} />}
            </li>
          ))}
        </FrameBox>
      );
  }
}

/**
 * "Connect X first" as a button (ADR 0040 part 2 §1). The link is this surface's own
 * Integrations page — never a URL from the model. Someone who may not connect it (the
 * agency's account, for an agent) is told who can.
 */
function ConnectButton({ label, mayConnect, href }: { label: string; mayConnect: boolean; href: string }) {
  if (!mayConnect) return <span className={styles.meta}>Ask an owner or admin to connect the agency’s {label}.</span>;
  return (
    <Link href={href} className={styles.connect}>
      Connect {label}
    </Link>
  );
}

function FrameBox({ title, total, shown, children }: { title: string; total?: number; shown?: number; children: React.ReactNode }) {
  return (
    <div className={styles.frame}>
      <div className={styles.frameHead}>
        {title}
        {total !== undefined ? (
          <span className={styles.muted}>
            {' '}
            · {shown !== undefined && shown < total ? `${shown} of ${total}` : total}
          </span>
        ) : null}
      </div>
      {shown === 0 ? <p className={styles.muted}>Nothing found.</p> : <ul className={styles.list}>{children}</ul>}
    </div>
  );
}

const STATUS_WORDS: Record<string, string> = {
  proposed: 'Waiting for you',
  running: 'Running…',
  done: 'Done',
  failed: 'Could not be done',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired — ask again',
  scheduled: 'Scheduled',
  approved: 'Approved',
};

/**
 * A proposed action's card (ADR 0025 §9). Everything on it is read back from
 * the database by id — the stream only told us which card. Approve / Reject
 * are the person's buttons; the model has no way to press them.
 */
export function ProposalCardView({ id, surface }: { id: string; surface: Surface }) {
  const [view, setView] = useState<ProposalView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Phase E: '' = now; otherwise minutes from now, or 'pick' for a chosen time. */
  const [when, setWhen] = useState('');
  const [picked, setPicked] = useState('');

  useEffect(() => {
    let live = true;
    void getProposedActionAction(id).then((r) => {
      if (!live) return;
      if (r.ok) setView(r.card);
      else setMessage(r.error);
    });
    return () => {
      live = false;
    };
  }, [id]);

  const press = async (fn: (id: string) => ReturnType<typeof approveProposedActionAction>) => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    const r = await fn(id);
    finish(r);
  };
  const runAtIso = (): string | null => {
    if (!when) return null;
    if (when === 'pick') return picked ? new Date(picked).toISOString() : null;
    return new Date(Date.now() + Number(when) * 60_000).toISOString();
  };
  const approve = async () => {
    if (pending) return;
    if (when === 'pick' && !picked) return setMessage('Choose a date and time first.');
    setPending(true);
    setMessage(null);
    finish(await approveProposedActionAction(id, runAtIso()));
  };
  const finish = (r: Awaited<ReturnType<typeof approveProposedActionAction>>) => {
    setPending(false);
    if (r.ok) {
      setView(r.card);
      if (r.message) setMessage(r.message);
    } else setMessage(r.error);
  };

  if (!view) return message ? <div className={styles.error}>{message}</div> : <div className={styles.status}>Loading the card…</div>;
  const { card } = view;
  const contactHref = `${PATHS[surface].contact}/${card.contact.id}`;
  const doneHref =
    view.status !== 'done'
      ? null
      : (view.tool === 'create_dashboard' || view.tool === 'update_dashboard') && view.result?.dashboardId
        ? `/dashboards/${view.result.dashboardId}`
        : view.tool === 'send_template_email' && view.result?.batchId
          ? `${PATHS[surface].bulk}/${view.result.batchId}`
          : view.tool === 'send_email' && view.result?.threadId
            ? `${PATHS[surface].inbox}?thread=${view.result.threadId}`
            : view.tool === 'message_colleagues' && view.result?.teamThreadId
              ? `${PATHS[surface].messages}?thread=${view.result.teamThreadId}`
            : view.tool === 'plan_task' && card.people?.length
              ? PATHS[surface].bulk
            : /_workflow$/.test(view.tool)
              ? PATHS[surface].workflows
            : /_skill$/.test(view.tool) && view.result?.agentSkillId
              ? `${PATHS[surface].skills}/${view.result.agentSkillId}`
            : /_listing/.test(view.tool) && view.result?.listingId
              ? `${PATHS[surface].listings}/${view.result.listingId}/edit`
          : view.tool === 'update_agent' || view.tool === 'remove_agent' || view.tool === 'invite_agent'
            ? '/team'
            : card.contact.id
            ? `${contactHref}?tab=${view.tool === 'add_note' ? 'notes' : /appointment/.test(view.tool) ? 'calendar' : 'overview'}`
            : null;
  const doneLabel =
    view.tool === 'create_dashboard' || view.tool === 'update_dashboard'
      ? 'Open the dashboard'
      : view.tool === 'send_template_email'
        ? 'Open the send report'
        : view.tool === 'send_email' || view.tool === 'message_colleagues'
          ? 'Open the conversation'
        : view.tool === 'plan_task' && card.people?.length
          ? 'Open Bulk email'
        : /_workflow$/.test(view.tool)
          ? 'Open Workflows'
        : /_skill$/.test(view.tool)
          ? 'Open the skill'
        : /_listing/.test(view.tool)
          ? 'Open the listing'
        : view.tool === 'update_agent' || view.tool === 'remove_agent' || view.tool === 'invite_agent'
          ? 'Open Agents & Team'
          : `Open ${card.contact.name}`;
  /**
   * A dashboard opens in a new tab; the other two destinations do not.
   *
   * Same reason as the Dashboards list: a dashboard is left up and refreshes itself, and
   * taking the panel's place would mean going Back to say anything else to the assistant.
   * A contact or a send report is somewhere you go next, so those still navigate.
   */
  const doneNewTab = view.tool === 'create_dashboard' || view.tool === 'update_dashboard';

  return (
    <div className={`${styles.frame} ${styles.card}`} data-status={view.status}>
      <div className={styles.frameHead}>
        {card.title}
        <span className={styles.badge}>{STATUS_WORDS[view.status] ?? view.status}</span>
      </div>
      <dl className={styles.cardLines}>
        {card.lines.map((l) => (
          <div key={l.label}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>
      {card.text ? (
        <div className={styles.cardText}>
          <div className={styles.label}>
            {card.text.label} — exactly as it will be {view.tool === 'send_email' || view.tool === 'message_colleagues' || card.people?.length ? 'sent' : 'saved'}
          </div>
          {card.text.value}
        </div>
      ) : null}
      {card.figures?.length ? (
        <p className={styles.cardNote}>
          <strong>Check these figures:</strong> {card.figures.join(' · ')}
        </p>
      ) : null}
      {card.people?.length ? (
        <ul className={styles.people}>
          {card.people.map((p, i) => (
            <li key={`${p.email ?? p.name}-${i}`} data-skipped={p.willReceive ? undefined : ''}>
              <span>{p.name}</span>
              <span className={styles.meta}>{p.willReceive ? p.email : `Skipped — ${p.reason ?? 'cannot receive it'}`}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.changes?.length ? (
        <ul className={styles.people}>
          {card.changes.map((c, i) => (
            <li key={`${c.email ?? c.name}-${i}`} data-skipped={c.skipped ? '' : undefined}>
              <span>
                {c.name}
                {c.email ? <span className={styles.meta}> · {c.email}</span> : null}
              </span>
              <span className={styles.meta}>{c.skipped ? `Skipped — ${c.skipped}` : `${c.before} → ${c.after}`}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {view.status === 'done' && view.tool === 'send_template_email' && view.result ? (
        <p className={styles.cardNote}>
          {view.result.sendError
            ? view.result.sendError
            : `Sent ${view.result.sent ?? 0}${view.result.skipped ? ` · ${view.result.skipped} skipped at sending` : ''}${view.result.failed ? ` · ${view.result.failed} failed` : ''}.`}
        </p>
      ) : null}
      {view.status === 'done' && view.tool === 'send_email' && view.result?.emailStatus ? (
        <p className={view.result.emailStatus === 'failed' ? styles.error : styles.cardNote}>
          {view.result.emailStatus === 'sent'
            ? 'Sent. Their reply comes back to the inbox.'
            : view.result.emailStatus === 'sending'
              ? 'Being sent — the conversation shows when it has gone.'
              : `Not delivered: ${view.result.emailError}`}
        </p>
      ) : null}
      {view.status === 'done' && view.tool === 'message_colleagues' ? (
        <p className={styles.cardNote}>{view.result?.emailed === false ? 'Sent — it is in their Team messages (the email copy did not go out).' : 'Sent — in their Team messages and by email.'}</p>
      ) : null}
      {view.status === 'done' && view.tool === 'schedule_team_meeting' && view.result ? (
        <p className={view.result.told ? styles.cardNote : styles.error}>
          {view.result.told
            ? 'Booked — everyone on it was notified and emailed the details.'
            : `Booked. ${view.result.zoomError ?? 'Nobody was emailed yet — press Retry on the Calendar page.'}`}
        </p>
      ) : null}
      {view.status === 'done' && view.tool === 'schedule_appointment' && view.result && (view.result.invited || view.result.invitationError) ? (
        <p className={view.result.invited ? styles.cardNote : styles.error}>
          {view.result.invited ? 'Booked, and the invitation was emailed.' : `Booked. ${view.result.invitationError}`}
        </p>
      ) : null}
      {view.status === 'done' && view.tool === 'invite_agent' ? (
        <p className={styles.cardNote}>
          {view.result?.emailed
            ? 'Invited — the link was emailed to them.'
            : 'Invited, but the link was not emailed — copy it from Agents & Team → Pending invites.'}
        </p>
      ) : null}
      {view.status === 'done' && view.tool === 'update_agent' && view.result?.claimPath ? (
        <p className={styles.cardNote}>
          {view.result.emailed
            ? 'The new invite link was emailed to the new address.'
            : 'The new invite link was not emailed — copy it from Agents & Team → Pending invites.'}
        </p>
      ) : null}
      {card.notes.map((n) => (
        <p key={n} className={styles.cardNote}>
          {n}
        </p>
      ))}
      {view.status === 'scheduled' && view.runAt ? (
        <p className={styles.cardNote}>
          Runs at about {new Date(view.runAt).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{' '}
          (up to 5 minutes later). Everything is checked again when it runs. You can cancel it until then.
        </p>
      ) : null}
      {view.error ? <div className={styles.error}>{view.error}</div> : null}
      {view.status === 'failed' && view.result?.needsConnection?.length ? (
        <div className={styles.connectRow}>
          {view.result.needsConnection.map((a) => (
            <ConnectButton key={a.provider} label={a.label} mayConnect={a.mayConnect} href={PATHS[surface].integrations} />
          ))}
        </div>
      ) : null}
      {message ? <div className={styles.error}>{message}</div> : null}
      {view.mayDecide && view.scheduling ? (
        <div className={styles.cardNote}>
          <label>
            When:{' '}
            <select value={when} onChange={(e) => setWhen(e.target.value)} disabled={pending}>
              <option value="">Now</option>
              <option value="10">In 10 minutes</option>
              <option value="60">In 1 hour</option>
              <option value="180">In 3 hours</option>
              <option value="pick">At a time I choose…</option>
            </select>
          </label>
          {when === 'pick' ? (
            <input
              type="datetime-local"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              min={new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)}
              max={new Date(Date.now() + 48 * 3_600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)}
              style={{ marginLeft: '0.5rem' }}
            />
          ) : null}
          {when ? <div>Runs at about that time — up to 5 minutes later, never earlier. At most 48 hours ahead.</div> : null}
        </div>
      ) : null}
      <div className={styles.cardActions}>
        {view.mayDecide ? (
          <>
            <button type="button" className={styles.send} disabled={pending} onClick={approve}>
              {pending ? 'Working…' : when ? 'Approve for later' : 'Approve'}
            </button>
            <button type="button" className={styles.ghost} disabled={pending} onClick={() => press(rejectProposedActionAction)}>
              Reject
            </button>
          </>
        ) : null}
        {view.mayCancel && !view.mayDecide ? (
          <button type="button" className={styles.ghost} disabled={pending} onClick={() => press(cancelProposedActionAction)}>
            Cancel
          </button>
        ) : null}
        {doneHref ? (
          <Link href={doneHref} {...(doneNewTab ? { target: '_blank', rel: 'noopener' } : {})}>
            {doneLabel}{doneNewTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

