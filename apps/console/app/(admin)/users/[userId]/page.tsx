import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LocalTime } from '@repo/ui';
import { getSiteUser, getSiteUserChat, PlatformError, type SiteUserChat } from '@repo/core/platform';
import { BarList, Stat } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

/**
 * One public-site user (ADR 0051): where they look, which agencies' listings
 * they open, save and enquire about, their saved searches, and their
 * conversations with the property guide (`?c=` opens one).
 */

const CHANNEL: Record<string, string> = { sale: 'buy', rent: 'rent', sold: 'sold', leased: 'leased' };

function searchWords(q: Record<string, unknown> | null): string {
  if (!q) return '';
  const parts: string[] = [];
  if (q.bedrooms) parts.push(`${q.bedrooms}+ bed`);
  if (q.bathrooms) parts.push(`${q.bathrooms}+ bath`);
  if (q.propertyType) parts.push(String(q.propertyType));
  if (q.priceFrom || q.priceTo) parts.push(`$${Number(q.priceFrom ?? 0).toLocaleString('en-AU')}–${q.priceTo ? `$${Number(q.priceTo).toLocaleString('en-AU')}` : 'any'}`);
  if (q.radiusKm) parts.push(`within ${q.radiusKm} km`);
  if (q.text) parts.push(`“${String(q.text)}”`);
  return parts.join(' · ');
}

export default async function SiteUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId } = await params;
  const raw = (await searchParams).c;
  const chatId = (Array.isArray(raw) ? raw[0] : raw)?.trim() || null;
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, chatId ? 'user_chat' : 'user', chatId ?? userId, userId);
  const db = getConsoleDb();

  let u;
  let chat: SiteUserChat | null = null;
  try {
    [u, chat] = await Promise.all([getSiteUser(db, admin, userId), chatId ? getSiteUserChat(db, admin, userId, chatId) : Promise.resolve(null)]);
  } catch (err) {
    if (err instanceof PlatformError && err.code === 'not_found') notFound();
    throw err;
  }

  if (chat) {
    return (
      <div className={styles.wrap}>
        <div className={styles.crumbs}>
          <Link href="/users">Users</Link> <span aria-hidden>/</span> <Link href={`/users/${userId}`}>{u.name}</Link>
        </div>
        <div className={styles.headText}>
          <h1 className={styles.title}>{chat.title}</h1>
          <p className={styles.sub}>{u.name}’s conversation with the property guide.</p>
        </div>
        <section className={styles.card}>
          <div className={styles.messages}>
            {chat.messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? styles.ask : styles.message}>
                <div className={styles.messageMeta}>
                  <span className={styles.messageWho}>{m.role === 'user' ? u.name : 'Property guide'}</span>
                  <LocalTime iso={m.at.toISOString()} />
                </div>
                <div className={styles.messageText}>{m.text}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.crumbs}>
        <Link href="/users">Users</Link> <span aria-hidden>/</span> <span>{u.name}</span>
      </div>
      <div className={styles.profileHead}>
        <div className={styles.avatarLg} aria-hidden>{u.name.slice(0, 2).toUpperCase()}</div>
        <div className={styles.headText}>
          <h1 className={styles.title}>{u.name}</h1>
          <p className={styles.sub}>
            {u.email}
            {u.phone ? ` · ${u.phone}` : ''} · joined <LocalTime iso={u.createdAt.toISOString()} style="date" />
            {u.lastActiveAt ? <> · last active <LocalTime iso={u.lastActiveAt.toISOString()} /></> : null}
          </p>
        </div>
      </div>

      <div className={styles.stats}>
        <Stat label="Searches" value={u.searches} />
        <Stat label="Listings opened" value={u.views} />
        <Stat label="Enquiries" value={u.enquiries} />
        <Stat label="Saved searches" value={u.savedSearches} />
        <Stat label="Shortlisted" value={u.shortlist} />
        <Stat label="Guide chats" value={u.chats} />
      </div>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Where they look</h2>
            <p className={styles.sub}>Suburbs, by searches and listings opened.</p>
          </div>
          <BarList
            empty="No searches recorded."
            rows={u.topSuburbs.map((r) => ({
              key: `${r.suburb}-${r.state}`,
              label: `${r.suburb}${r.state ? `, ${r.state}` : ''}`,
              title: r.suburb,
              value: r.searches + r.views,
              detail: `${r.searches} searches · ${r.views} views`,
            }))}
          />
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Agencies they are interested in</h2>
            <p className={styles.sub}>Listings opened, saved and enquired about.</p>
          </div>
          <BarList
            empty="Nothing yet."
            rows={u.topAgencies.map((r) => ({
              key: r.agencyId,
              label: <Link href={`/agencies/${r.agencyId}`}>{r.name}</Link>,
              title: r.name,
              value: r.views + r.saved + r.enquiries,
              detail: `${r.views} views · ${r.saved} saved · ${r.enquiries} enquiries`,
            }))}
          />
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardBody}><h2 className={styles.h2}>Enquiries</h2></div>
        {u.enquiryRows.length === 0 ? (
          <p className={styles.empty}>No enquiries.</p>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>When</th><th>Property</th><th>Agency</th><th>Kind</th><th>Status</th></tr></thead>
            <tbody>
              {u.enquiryRows.map((e) => (
                <tr key={e.id}>
                  <td><LocalTime iso={e.at.toISOString()} /></td>
                  <td data-label="Property">{e.address ?? '—'}{e.message ? <div className={styles.muted}>{e.message}</div> : null}</td>
                  <td data-label="Agency"><Link href={`/agencies/${e.agencyId}/leads`}>{e.agencyName}</Link></td>
                  <td data-label="Kind">{e.kind}</td>
                  <td data-label="Status">{e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}><h2 className={styles.h2}>Saved searches and alerts</h2></div>
          {u.savedSearchRows.length === 0 ? (
            <p className={styles.empty}>None.</p>
          ) : (
            <div className={styles.messages}>
              {u.savedSearchRows.map((s) => (
                <div key={s.id} className={styles.message}>
                  <div className={styles.messageMeta}>
                    <span className={styles.messageWho}>{s.name}</span>
                    <span>{s.cadence}</span>
                    <span className={s.status === 'active' ? styles.badgeGood : styles.badge}>{s.status}</span>
                  </div>
                  <div className={styles.messageText}>{s.prompt}</div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}><h2 className={styles.h2}>Shortlist</h2></div>
          {u.saved.length === 0 ? (
            <p className={styles.empty}>Nothing saved.</p>
          ) : (
            <table className={styles.table}>
              <tbody>
                {u.saved.map((s) => (
                  <tr key={s.listingId}>
                    <td>{s.address ?? 'Listing'}<div className={styles.muted}>{s.agencyName} · {s.status}</div></td>
                    <td data-label="Saved"><LocalTime iso={s.at.toISOString()} style="date" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardBody}><h2 className={styles.h2}>Conversations with the property guide</h2></div>
        {u.chatRows.length === 0 ? (
          <p className={styles.empty}>None.</p>
        ) : (
          <table className={styles.table}>
            <tbody>
              {u.chatRows.map((c) => (
                <tr key={c.id}>
                  <td><Link className={styles.name} href={`/users/${userId}?c=${c.id}`}>{c.title}</Link></td>
                  <td data-label="Messages" className={styles.num}>{c.messages} messages</td>
                  <td data-label="Last"><LocalTime iso={c.lastMessageAt.toISOString()} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <h2 className={styles.h2}>Recent activity</h2>
          <p className={styles.sub}>Searches and listings opened, newest first.</p>
        </div>
        {u.activity.length === 0 ? (
          <p className={styles.empty}>Nothing recorded yet.</p>
        ) : (
          <table className={styles.table}>
            <tbody>
              {u.activity.map((a, i) => (
                <tr key={`${a.at.toISOString()}-${i}`}>
                  <td><LocalTime iso={a.at.toISOString()} /></td>
                  <td data-label="What">
                    {a.kind === 'search' ? (
                      <>
                        Searched {a.channel ? `to ${CHANNEL[a.channel] ?? a.channel} ` : ''}in <strong>{a.suburb ?? 'anywhere'}</strong>
                        {searchWords(a.query) ? <div className={styles.muted}>{searchWords(a.query)}</div> : null}
                      </>
                    ) : (
                      <>
                        Opened <strong>{a.address ?? 'a listing'}</strong>
                        {a.agencyName ? <div className={styles.muted}>{a.agencyName}</div> : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
