import Link from 'next/link';
import {
  AUDIENCE_LABELS,
  listDashboards,
  type PreviewShape,
  type WidgetPreview,
} from '@repo/core/dashboards';
import { LocalTime } from '@repo/ui';
import contactStyles from '@/components/contacts/contacts.module.css';
import { PrefetchOnIntent } from '@/components/prefetch-on-intent';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { ArchiveDashboardButton } from './archive-button';
import styles from './dashboards.module.css';

/**
 * The dashboards this person may open (ADR 0027), as a grid of cards. Saved by
 * owners/admins through the assistant's card; opened by signed-in members of
 * the agency only.
 *
 * Both consoles call them Projects and open one inside their own chrome
 * (`/projects/[id]`, `/my-projects/[id]`), sidebar still there; the
 * full-screen page for a wall is a link from there.
 */
export async function DashboardsPage({ surface }: { surface: 'agency' | 'agent' }) {
  const session = await requireConsoleAccess(surface);
  const rows = await listDashboards(getConsoleDb(), session.actor);
  const agency = surface === 'agency';
  const base = agency ? '/projects' : '/my-projects';
  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>Projects</h1>
          <p className={contactStyles.sub}>
            Live figures that refresh about every minute.{' '}
            {agency
              ? 'To make one, ask the assistant — for example “make a dashboard with sold value and new leads this week” — and approve its card.'
              : 'Owners and admins make these; you see the ones shared with the whole agency, each figure as far as you may see it.'}
          </p>
        </div>
        {agency ? (
          <Link href="/overview" className={contactStyles.btn}>
            New with the assistant
          </Link>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className={styles.muted}>No projects yet.</p>
      ) : (
        <PrefetchOnIntent>
          <ul className={styles.cards}>
            {rows.map((d) => (
              <li key={d.id} className={styles.card}>
                <ProjectThumb title={d.title} tiles={d.preview} />
                {d.mayManage ? (
                  <div className={styles.cardActions}>
                    <ArchiveDashboardButton id={d.id} />
                  </div>
                ) : null}
                <div className={styles.cardBody}>
                  <span className={styles.cardIcon} aria-hidden>
                    monitoring
                  </span>
                  <div className={styles.cardText}>
                    <Link href={`${base}/${d.id}`} prefetch={false} className={styles.cardLink}>
                      {d.title}
                    </Link>
                    <div className={styles.cardMeta}>
                      {d.widgetCount} widget{d.widgetCount === 1 ? '' : 's'} ·{' '}
                      {AUDIENCE_LABELS[d.audience]} · Created{' '}
                      <time dateTime={d.createdAt.toISOString()}>
                        <LocalTime iso={d.createdAt.toISOString()} style="date" />
                      </time>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </PrefetchOnIntent>
      )}
    </div>
  );
}

/**
 * The card's picture: this board in miniature — its header, and each widget's
 * real title over the shape its tile draws (a figure, bars, a trend, a donut,
 * a table). Drawn, not screenshotted, and without figures: the numbers behind
 * a tile are computed per viewer, so no one image of them is true for
 * everyone (see preview.ts in core).
 */
const SHOWN_TILES = 6;

export function ProjectThumb({ title, tiles }: { title: string; tiles: WidgetPreview[] }) {
  const shown = tiles.slice(0, SHOWN_TILES);
  const cols = Math.min(Math.max(shown.length, 1), 3);
  return (
    <div className={styles.thumb} aria-hidden>
      <div className={styles.mBoard}>
        <div className={styles.mHead}>
          <div className={styles.mHeadText}>
            <span className={styles.mEyebrow}>Project</span>
            <span className={styles.mTitle}>{title}</span>
          </div>
          <span className={styles.mLive}>
            <span className={styles.mLiveDot} />
            Live
          </span>
        </div>
        <div
          className={styles.mGrid}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {shown.map((t, i) => (
            <div key={i} className={styles.mTile} data-single={shown.length === 1 ? '' : undefined}>
              <span className={styles.mTileTitle}>{t.title}</span>
              <MiniShape shape={t.shape} />
            </div>
          ))}
        </div>
        {tiles.length > SHOWN_TILES ? (
          <span className={styles.mMore}>+{tiles.length - SHOWN_TILES} more</span>
        ) : null}
      </div>
    </div>
  );
}

const COLUMN_HEIGHTS = [38, 62, 48, 80, 56, 100];
const BAR_WIDTHS = [92, 64, 40];

function MiniShape({ shape }: { shape: PreviewShape }) {
  switch (shape) {
    case 'figure':
      return <span className={styles.mFigure} />;
    case 'money':
      return (
        <>
          <span className={styles.mFigure} />
          <span className={styles.mSplit}>
            <span style={{ width: '72%' }} />
            <span />
          </span>
        </>
      );
    case 'bars':
      return (
        <>
          <span className={`${styles.mFigure} ${styles.mFigureSm}`} />
          {BAR_WIDTHS.map((w) => (
            <span key={w} className={styles.mBar} style={{ width: `${w}%` }} />
          ))}
        </>
      );
    case 'columns':
      return (
        <span className={styles.mColumns}>
          {COLUMN_HEIGHTS.map((h, i) => (
            <span
              key={i}
              style={{ height: `${h}%` }}
              data-last={i === COLUMN_HEIGHTS.length - 1 ? '' : undefined}
            />
          ))}
        </span>
      );
    case 'donut':
      return (
        <span className={styles.mDonutRow}>
          <span className={styles.mDonut} />
          <span className={styles.mLegend}>
            <span />
            <span />
            <span />
          </span>
        </span>
      );
    case 'line':
      return (
        <svg className={styles.mLine} viewBox="0 0 100 32" preserveAspectRatio="none">
          <path
            d="M0 26 L14 22 L28 24 L42 15 L56 18 L70 9 L84 12 L100 4 L100 32 L0 32 Z"
            className={styles.mLineArea}
          />
          <path
            d="M0 26 L14 22 L28 24 L42 15 L56 18 L70 9 L84 12 L100 4"
            className={styles.mLineStroke}
          />
        </svg>
      );
    case 'table':
      return (
        <span className={styles.mTable}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={styles.mRow}>
              <span />
              <span />
            </span>
          ))}
        </span>
      );
  }
}
