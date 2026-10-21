import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { PlatformError } from './admin';

/**
 * Who is online, and the admin dashboard's people figures (ADR 0052).
 *
 * "Online" = `user.last_seen_at` within the last 5 minutes. An open console
 * page refreshes it through its live poll and an open site page through a
 * once-a-minute ping (signed-in visitors only); both go through
 * `touchLastSeen`, which writes at most once a minute per person.
 */

export const ONLINE_MINUTES = 5;
const UUID = /^[0-9a-f-]{36}$/i;
const n = (v: unknown) => Number(v ?? 0);

/** Mark a person as here now. A no-op inside the same minute. One statement. */
export async function touchLastSeen(db: DbOrTx, userId: string): Promise<void> {
  if (!UUID.test(userId)) return;
  await db.execute(sql`
    update "user" set last_seen_at = now()
    where id = ${userId} and (last_seen_at is null or last_seen_at < now() - interval '60 seconds')`);
}

/** Who counts as which (the same rules as the Users and Agents sections). */
const SITE_USER = sql.raw(
  `not exists (select 1 from membership m where m.user_id = u.id) and not exists (select 1 from platform_admin pa where pa.user_id = u.id)`,
);
const ONLINE = sql.raw(`u.last_seen_at > now() - interval '${ONLINE_MINUTES} minutes'`);

export type PlatformPeople = {
  agencies: { total: number; online: number; suspended: number };
  agents: { total: number; online: number; blocked: number };
  users: { total: number; online: number; blocked: number };
  onlineNow: { userId: string; name: string; email: string; kind: 'member' | 'user'; agencyId: string | null; agencyName: string | null; role: string | null; lastSeenAt: Date }[];
  recentAgencies: { id: string; name: string; status: string; createdAt: Date; owner: string | null }[];
  recentMembers: { userId: string; name: string; email: string; role: string; agencyId: string; agencyName: string; joinedAt: Date; lastSeenAt: Date | null }[];
  recentUsers: { userId: string; name: string; email: string; createdAt: Date; lastSeenAt: Date | null; blocked: boolean }[];
};

/** The dashboard's people: totals, who is online now, and the newest of each. Five statements, started together. */
export async function platformPeople(db: Db, admin: Actor): Promise<PlatformPeople> {
  if (!can(admin, 'platform:read', { type: 'platform' })) {
    throw new PlatformError('forbidden', 'Only a platform admin may open the admin console');
  }
  const [[t], online, agencies, members, users] = await Promise.all([
    db.execute<Record<string, number>>(sql`
      select
        (select count(*)::int from agency) as agencies,
        (select count(*)::int from agency a where a.status = 'suspended') as suspended,
        (select count(*)::int from agency a where exists (
          select 1 from membership m join "user" u on u.id = m.user_id
          where m.agency_id = a.id and m.status = 'active' and ${ONLINE})) as agencies_online,
        (select count(*)::int from membership m where m.status = 'active') as agents,
        (select count(*)::int from membership m join "user" u on u.id = m.user_id where m.status = 'active' and ${ONLINE}) as agents_online,
        (select count(*)::int from membership m where m.status = 'suspended' and m.removed_at is null) as agents_blocked,
        (select count(*)::int from "user" u where ${SITE_USER}) as users,
        (select count(*)::int from "user" u where ${SITE_USER} and ${ONLINE}) as users_online,
        (select count(*)::int from "user" u where ${SITE_USER} and u.blocked_at is not null) as users_blocked`),
    db.execute<Record<string, unknown>>(sql`
      select u.id, coalesce(nullif(u.name, ''), u.email) as name, u.email, u.last_seen_at,
        m.agency_id, a.name as agency_name, m.role
      from "user" u
      left join membership m on m.user_id = u.id and m.status = 'active'
      left join agency a on a.id = m.agency_id
      where ${ONLINE} and not exists (select 1 from platform_admin pa where pa.user_id = u.id)
      order by u.last_seen_at desc limit 30`),
    db.execute<Record<string, unknown>>(sql`
      select a.id, a.name, a.status, a.created_at,
        (select coalesce(nullif(u.name, ''), u.email) from membership m join "user" u on u.id = m.user_id
         where m.agency_id = a.id and m.role = 'owner' order by m.created_at limit 1) as owner
      from agency a order by a.created_at desc limit 8`),
    db.execute<Record<string, unknown>>(sql`
      select u.id, coalesce(nullif(u.name, ''), u.email) as name, u.email, m.role, m.agency_id, a.name as agency_name,
        coalesce(m.joined_at, m.created_at) as joined_at, u.last_seen_at
      from membership m join "user" u on u.id = m.user_id join agency a on a.id = m.agency_id
      where m.status = 'active' order by coalesce(m.joined_at, m.created_at) desc limit 8`),
    db.execute<Record<string, unknown>>(sql`
      select u.id, coalesce(nullif(u.name, ''), u.email) as name, u.email, u.created_at, u.last_seen_at, u.blocked_at
      from "user" u where ${SITE_USER} order by u.created_at desc limit 8`),
  ]);
  const date = (v: unknown) => new Date(v as string);
  return {
    agencies: { total: n(t?.agencies), online: n(t?.agencies_online), suspended: n(t?.suspended) },
    agents: { total: n(t?.agents), online: n(t?.agents_online), blocked: n(t?.agents_blocked) },
    users: { total: n(t?.users), online: n(t?.users_online), blocked: n(t?.users_blocked) },
    onlineNow: [...online].map((r) => ({
      userId: r.id as string,
      name: String(r.name),
      email: String(r.email),
      kind: r.agency_id ? 'member' : 'user',
      agencyId: (r.agency_id as string | null) ?? null,
      agencyName: (r.agency_name as string | null) ?? null,
      role: (r.role as string | null) ?? null,
      lastSeenAt: date(r.last_seen_at),
    })),
    recentAgencies: [...agencies].map((r) => ({ id: r.id as string, name: String(r.name), status: String(r.status), createdAt: date(r.created_at), owner: (r.owner as string | null) ?? null })),
    recentMembers: [...members].map((r) => ({
      userId: r.id as string,
      name: String(r.name),
      email: String(r.email),
      role: String(r.role),
      agencyId: r.agency_id as string,
      agencyName: String(r.agency_name),
      joinedAt: date(r.joined_at),
      lastSeenAt: r.last_seen_at ? date(r.last_seen_at) : null,
    })),
    recentUsers: [...users].map((r) => ({
      userId: r.id as string,
      name: String(r.name),
      email: String(r.email),
      createdAt: date(r.created_at),
      lastSeenAt: r.last_seen_at ? date(r.last_seen_at) : null,
      blocked: Boolean(r.blocked_at),
    })),
  };
}
