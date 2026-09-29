import { WebShell } from '../../components/web-shell';
import { currentWebUser } from '../../lib/session';
import styles from './chat.module.css';

/**
 * The one dynamic route on this site that had no loader.
 *
 * `/search`, `/alerts`, `/account` and `/listing/[id]` all have one; `/chat`
 * did not, and it is the slowest of them for a signed-in visitor. The page
 * is `force-dynamic` and the request behind it is a Supabase `getUser()` in
 * middleware (0.3–0.9 s, measured) plus `listThreads` and, when the URL
 * names one, `getThread` — each a round trip to the database in Seoul at
 * ~196 ms. Half a second to a second before anything paints, and until this
 * file existed the browser showed the PREVIOUS page for all of it. Clicking
 * a conversation in the rail did nothing you could see, so people clicked
 * it again.
 *
 * ## It draws the page, not a spinner
 *
 * Same rule as the other four loaders: the rail, the toolbar and the hero
 * in their real positions, so the arrival is a fill rather than a flash.
 * The rail's width in particular — swapping a spinner for a two-column
 * layout moves every pixel on the screen.
 *
 * ## Why it reads the session
 *
 * `currentWebUser` is a header read, not a query (ADR 0008): middleware has
 * already verified the session and written `x-web-user-id`, and this costs
 * nothing. Without it the header would draw with no account control and
 * grow one when the real page landed — a shift in the top-right corner on
 * every single navigation to the guide, which is precisely the class of
 * jump this file exists to remove.
 */
export default async function Loading() {
  const user = await currentWebUser();

  return (
    <WebShell wide account={{ signedIn: Boolean(user) }}>
      <div className={`${styles.page} ${styles.pageEmpty}`} aria-busy="true">
        <aside className={styles.rail} aria-hidden>
          <div className={styles.railHead}>
            <div className="h-9 w-full animate-pulse rounded-xl bg-sunken" />
          </div>
          <div className={styles.railList}>
            {/* Widths vary, because a column of identical bars reads as a
                table being drawn rather than as titles arriving. */}
            {['70%', '85%', '55%', '78%', '62%'].map((w, i) => (
              <div key={i} className="mx-1 my-2 h-4 animate-pulse rounded bg-sunken" style={{ width: w }} />
            ))}
          </div>
        </aside>

        <div className={styles.content}>
          <div className={styles.split}>
            <section className={styles.main} aria-label="Loading the property guide">
              <div className={styles.toolbar}>
                <div className={styles.toolbarRow}>
                  <div className="h-8 w-28 animate-pulse rounded-full bg-sunken" />
                </div>
              </div>

              <div className={styles.hero}>
                <div className="h-6 w-64 animate-pulse rounded-full bg-sunken" />
                <div className="h-9 w-full max-w-md animate-pulse rounded-lg bg-sunken" />
                <div className="h-4 w-full max-w-sm animate-pulse rounded bg-sunken" />
                {/* The composer, at the height it actually is, so the box
                    does not jump up the page when the real one mounts. */}
                <div className="h-32 w-full animate-pulse rounded-2xl bg-sunken" />
              </div>
            </section>
          </div>
        </div>
      </div>
    </WebShell>
  );
}
