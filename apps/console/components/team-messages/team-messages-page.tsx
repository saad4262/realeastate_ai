import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import {
  getTeamThread,
  listColleagues,
  listTeamThreads,
  TeamMessageError,
  type TeamThreadPage,
  type TeamThreadView,
} from '@repo/core/team-messages';
import { snippet } from '@repo/core/mail';
import { getConsoleDb } from '../../lib/db';
import { loadActor } from '../../lib/load-actor';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { NewTeamMessage, TeamMarkRead, TeamReply } from './islands';
import inbox from '../inbox/inbox.module.css';
import styles from './team-messages.module.css';

/**
 * Team messages (ADR 0035 §3), shared by `/messages` (agency console) and
 * `/my-messages` (agent desk). The inbox's layout: a list of conversations;
 * opening one replaces it. `?thread=` opens one, `?new=1` starts one
 * (`&to=<userId>` ticks a colleague). Only conversations you are ON are ever
 * loaded — core's `team_message:read`, never this file, decides.
 */
export async function TeamMessagesPage({
  surface,
  searchParams,
}: {
  surface: 'agency' | 'agent';
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleAccess(surface);
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || '';
  const threadId = first(params.thread) || null;
  const starting = first(params.new) === '1';
  const basePath = surface === 'agency' ? '/messages' : '/my-messages';
  const db = getConsoleDb();
  const actor = (await loadActor(session.actor.userId)) ?? session.actor;

  const [listed, opened, colleagues] = await Promise.all([
    listTeamThreads(db, actor).then(
      (page): { ok: true; page: TeamThreadPage } => ({ ok: true, page }),
      (err: unknown) => ({ ok: false as const, error: err instanceof TeamMessageError ? err.message : 'Could not load team messages' }),
    ),
    threadId
      ? getTeamThread(db, actor, threadId).then(
          (view) => ({ ok: true as const, view }),
          (err: unknown) => ({ ok: false as const, error: err instanceof TeamMessageError ? err.message : 'Could not open that conversation' }),
        )
      : Promise.resolve(null),
    starting ? listColleagues(db, actor) : Promise.resolve([]),
  ]);

  if (!listed.ok) {
    return (
      <p role="alert" className={inbox.alert}>
        {listed.error}
      </p>
    );
  }
  const page = listed.page;

  return (
    <div className={inbox.wrap}>
      <div className={inbox.head}>
        <div>
          <h1 className={inbox.title}>Team messages</h1>
          <p className={inbox.sub}>
            Write to anyone in the agency. They see it here and get it by email; replying to that email lands
            back here. Only the people on a conversation can read it.
          </p>
        </div>
        {page.maySend && !starting ? (
          <Link href={`${basePath}?new=1`} className={inbox.newButton}>
            New message
          </Link>
        ) : null}
      </div>

      <section className={inbox.card} aria-label={starting ? 'New message' : opened ? 'Conversation' : 'Conversations'}>
        {starting ? (
          <>
            <div className={inbox.toolbar}>
              <Link href={basePath} className={inbox.back}>
                ← All conversations
              </Link>
            </div>
            {page.maySend ? (
              <NewTeamMessage colleagues={colleagues} basePath={basePath} preselected={first(params.to) ? [first(params.to)] : []} />
            ) : (
              <p className={inbox.readonly}>You can read team messages sent to you, but not write them.</p>
            )}
          </>
        ) : opened === null ? (
          <ThreadList page={page} basePath={basePath} />
        ) : !opened.ok ? (
          <>
            <div className={inbox.toolbar}>
              <Link href={basePath} className={inbox.back}>
                ← All conversations
              </Link>
            </div>
            <p className={inbox.alert} role="alert">
              {opened.error}
            </p>
          </>
        ) : (
          <Reader view={opened.view} basePath={basePath} unread={page.rows.find((r) => r.id === opened.view.id)?.unread ?? true} />
        )}
      </section>
    </div>
  );
}

function initial(name: string): string {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

function ThreadList({ page, basePath }: { page: TeamThreadPage; basePath: string }) {
  if (page.rows.length === 0) {
    return (
      <div className={inbox.empty}>
        <p className={inbox.emptyTitle}>No team messages yet</p>
        <p className={inbox.emptyHint}>
          {page.maySend ? 'Press New message to write to a colleague — or ask the assistant to.' : 'Messages colleagues send you will show here.'}
        </p>
      </div>
    );
  }
  return (
    <ul className={inbox.list}>
      {page.rows.map((r) => (
        <li key={r.id} className={inbox.item}>
          <Link href={`${basePath}?thread=${r.id}`} className={`${inbox.row} ${r.unread ? inbox.unread : ''}`}>
            <span className={r.unread ? inbox.dot : inbox.noDot} aria-label={r.unread ? 'Unread' : undefined} />
            <span className={inbox.sender}>{r.others.join(', ') || 'Only you'}</span>
            <span className={inbox.line}>
              <span className={inbox.subject}>{r.subject}</span>
              <span className={inbox.snippet}>
                — {r.lastFromMe ? 'You: ' : ''}
                {r.preview}
              </span>
            </span>
            <time className={inbox.time} dateTime={r.lastMessageAt.toISOString()}>
              <LocalTime iso={r.lastMessageAt.toISOString()} />
            </time>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Reader({ view, basePath, unread }: { view: TeamThreadView; basePath: string; unread: boolean }) {
  const others = view.people.filter((p) => !p.you);
  const openFrom = Math.max(0, view.messages.length - 3);
  const activeOthers = others.filter((p) => p.active);
  return (
    <div>
      <TeamMarkRead threadId={view.id} unread={unread} />
      <div className={inbox.toolbar}>
        <Link href={basePath} className={inbox.back}>
          ← All conversations
        </Link>
      </div>
      <header className={inbox.threadHead}>
        <div className={inbox.threadTitle}>
          <h2 className={inbox.readerTitle}>{view.subject}</h2>
          <span className={`${inbox.badge} ${inbox.badgeMail}`}>Team</span>
        </div>
        <p className={styles.peopleLine}>
          With{' '}
          {others.map((p, i) => (
            <span key={p.userId}>
              {i > 0 ? ', ' : ''}
              <span className={p.active ? undefined : styles.gone} title={p.active ? p.email : 'No longer in the agency'}>
                {p.name}
              </span>
            </span>
          ))}
        </p>
      </header>
      <div className={inbox.messages}>
        {view.messages.map((m, i) => (
          <details key={m.id} className={inbox.message} open={i >= openFrom}>
            <summary className={inbox.messageHead}>
              <span className={`${inbox.avatar} ${m.mine ? inbox.avatarUs : ''}`} aria-hidden>
                {initial(m.senderName)}
              </span>
              <span className={inbox.who}>
                <span className={inbox.fromLine}>
                  <span className={inbox.fromName}>{m.mine ? 'You' : m.senderName}</span>
                  {m.channel === 'email' ? <span className={styles.via}>replied by email</span> : null}
                </span>
                <span className={inbox.collapsedSnippet}>{snippet(m.text)}</span>
              </span>
              <time className={inbox.when} dateTime={m.createdAt.toISOString()}>
                <LocalTime iso={m.createdAt.toISOString()} />
              </time>
            </summary>
            <div className={inbox.body}>
              <div className={inbox.bodyText}>{m.text}</div>
            </div>
          </details>
        ))}
      </div>
      {view.maySend && activeOthers.length > 0 ? (
        <TeamReply threadId={view.id} to={activeOthers.map((p) => p.name).join(', ')} />
      ) : (
        <p className={inbox.readonly}>
          {view.maySend ? 'Nobody else on this conversation is still in the agency.' : 'You can read this conversation, but not write on it.'}
        </p>
      )}
    </div>
  );
}
