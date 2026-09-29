import { WebShell } from '../../components/web-shell';
import { Bar } from '../../components/skeletons';
import styles from './account.module.css';

/**
 * § 10 — this route queries the database, so it declares what it is doing
 * instead of leaving the previous page on screen.
 *
 * ## Why it is the whole page and not a word
 *
 * It used to be the header alone, with the literal string "Loading…" where
 * the email goes and nothing at all below it. That is a THIRD layout — not
 * the previous page, not this one — so arriving here meant a header sliding
 * up as four cards appeared under it, and "Loading…" being replaced by an
 * address mid-sentence. The rest of the site's loaders (`/alerts`,
 * `/search`, `/listing/[id]`, `/chat`) had already settled on the opposite
 * rule: draw the page with its text removed, so the real one fills this in
 * rather than replacing it.
 *
 * So the shape here is page.tsx's, card for card: identity, the three-row
 * account table, saved searches, security, and the sign-out rule at the
 * bottom. `Bar` carries the shimmer and honours `prefers-reduced-motion` on
 * its own — see components/skeleton.module.css.
 *
 * The avatar keeps its real class rather than becoming a bar. It is a solid
 * accent circle at a fixed 3.25rem whether or not anybody is signed in; only
 * the initial inside it is unknown, and a grey disc where a green one is
 * about to be would be the one thing on this screen that changes colour.
 *
 * `signedIn: true` is safe to assert here: middleware has already redirected
 * anyone without a session away from /account, so a skeleton for this route
 * is only ever rendered for somebody who has one.
 */
export default function AccountLoading() {

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading your account">
        <header className={styles.head}>
          <span className={styles.avatar} aria-hidden />
          <div className={styles.identity} aria-hidden>
            {/* The name, at the size .title renders it, then the email under
                it at .email's — the two lines this header actually has. */}
            <Bar w="11rem" h="1.875rem" />
            <div className="mt-2">
              <Bar w="14rem" h="0.9375rem" />
            </div>
          </div>
        </header>

        {/* Account — three label/value rows on the same 8.5rem grid the real
            table uses, so the values do not shift left when they land. */}
        <section className={styles.card} aria-hidden>
          <div className={styles.cardLabel}>
            <Bar w="4.5rem" h="0.6875rem" />
          </div>
          <div className={styles.rows}>
            {['7rem', '13rem', '8rem'].map((w, i) => (
              <div key={i} className={styles.row}>
                <Bar w="4rem" h="0.875rem" />
                <Bar w={w} h="0.9375rem" />
              </div>
            ))}
          </div>
        </section>

        {/* Saved searches, and Security. The same card twice: a label, a line
            or two of body copy, and a pill. Their body text differs by a line,
            which is the only reason the second one has three bars. */}
        {[
          { label: '8rem', body: ['70%'], pill: '7.5rem' },
          { label: '5rem', body: ['95%', '55%'], pill: '10rem' },
        ].map((card, i) => (
          <section key={i} className={styles.card} aria-hidden>
            <div className={styles.cardLabel}>
              <Bar w={card.label} h="0.6875rem" />
            </div>
            <div className={styles.body}>
              {card.body.map((w, j) => (
                <div key={j} className={j === 0 ? '' : 'mt-2'}>
                  <Bar w={w} h="0.9375rem" />
                </div>
              ))}
            </div>
            {/* At the pill's real height — .secondary is 0.5rem of padding
                either side of 0.875rem type. */}
            <Pill w={card.pill} h="2.125rem" />
          </section>
        ))}

        {/* The rule above sign-out is a real border, not a bar: it is drawn
            the same on both sides of the swap, so barring it would make a
            line thicken as the page arrived. */}
        <div className={styles.signOut} aria-hidden>
          <Pill w="6.5rem" h="2.25rem" />
          <Bar w="15rem" h="0.8125rem" />
        </div>
      </main>
    </WebShell>
  );
}

/**
 * A `Bar` with the corners of the thing it stands in for.
 *
 * `.secondary` and `.danger` are both `border-radius: 9999px`, and `Bar`'s
 * own radius is 0.375rem — so a plain bar here is a rounded rectangle that
 * becomes a pill on arrival. Small, but it is the one shape on this screen
 * that would visibly change rather than fill.
 */
function Pill({ w, h }: { w: string; h: string }) {
  return (
    <span className="inline-block overflow-hidden rounded-full" style={{ width: w, height: h }}>
      <Bar w="100%" h="100%" />
    </span>
  );
}
