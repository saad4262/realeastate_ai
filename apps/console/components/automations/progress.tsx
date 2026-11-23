import styles from './automation-detail.module.css';

/**
 * How far a send or a run has got, the same way everywhere (the user, 2026-11-23): % complete, a bar split into what went and what
 * failed, the time left when there is a pace to go by, and four counts. `left` is what has not gone yet.
 */
export function Progress({ sent, failed, skipped, left, noun = 'Sent', timeLeft }: { sent: number; failed: number; skipped: number; left: number; noun?: string; timeLeft?: string | null }) {
  const done = sent + failed;
  const of = done + left;
  const pct = of > 0 ? Math.min(100, Math.floor((done / of) * 100)) : null;
  const width = (n: number) => (of > 0 ? `${(n / of) * 100}%` : '0%');
  return (
    <div className={styles.progress}>
      <div className={styles.progressHead}>
        <span className={styles.pct}>{pct === null ? 'Nothing to send' : `${pct}% complete`}</span>
        <span className={styles.muted}>{left > 0 ? (timeLeft ? `About ${timeLeft} left` : `${left} to go`) : pct === null ? '' : 'Finished'}</span>
      </div>
      <span className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0} aria-label="Progress">
        <span className={styles.barSent} style={{ width: width(sent) }} />
        <span className={styles.barFailed} style={{ width: width(failed) }} />
      </span>
      <div className={styles.tiles}>
        <Tile n={sent} label={noun} tone="good" />
        <Tile n={failed} label="Failed" tone="bad" />
        <Tile n={skipped} label="Skipped" />
        <Tile n={left} label="Left" tone="live" />
      </div>
    </div>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: 'good' | 'bad' | 'live' }) {
  return (
    <div className={styles.tile} data-tone={n > 0 ? tone : undefined}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}
