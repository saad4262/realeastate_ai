'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import type { AgencyAgentRow } from '@repo/core/team';
import styles from './team.module.css';

const TABS = [
  { id: 'all', label: 'All Agents' },
  { id: 'active', label: 'Active' },
  { id: 'invited', label: 'Pending invite' },
] as const;

type Agent = {
  id: string;
  name: string;
  role: string;
  /** Null when no photo was given — initials are drawn instead of a stock face. */
  avatar: string | null;
  license: string;
  suburbs: string[];
  status: string;
  email: string;
  aiLabel: string;
  aiTone: 'blue' | 'amber' | 'green' | 'gray';
  aiIcon: string;
  aiHint: string;
  isAgencyAdmin: boolean;
  /** The row as stored, so the dossier can show every field the wizard asked for. */
  row: AgencyAgentRow;
};

function mapRow(row: AgencyAgentRow): Agent {
  const roleLabel =
    row.operationalRole ||
    (row.role === 'owner'
      ? 'Licensee in Charge'
      : row.role === 'admin'
        ? 'Agency Admin'
        : row.role === 'property_manager'
          ? 'Property Manager'
          : row.role === 'assistant'
            ? 'Associate'
            : 'Sales Agent');

  return {
    id: row.userId,
    name: row.name,
    role: roleLabel,
    // A default stock photo made every agent look like the same person.
    avatar: row.photoUrl || null,
    license: row.licenceNumber ? `Lic #${row.licenceNumber}` : 'Licence pending',
    suburbs: row.territorySuburbs?.length ? row.territorySuburbs : ['—'],
    status: row.status,
    email: row.email,
    aiLabel: row.status === 'invited' ? 'Invite pending' : 'Rostered',
    aiTone: row.status === 'invited' ? 'amber' : 'blue',
    aiIcon: row.status === 'invited' ? 'schedule' : 'verified',
    aiHint: row.specialties?.join(', ') || 'No specialties set',
    isAgencyAdmin: row.isAgencyAdmin,
    row,
  };
}

function aiClass(tone: Agent['aiTone']) {
  if (tone === 'blue') return styles.badgeBlue;
  if (tone === 'amber') return styles.badgeAmber;
  if (tone === 'green') return styles.badgeGreen;
  return styles.badgeGray;
}


const initialsStyle = {
  display: 'grid',
  placeItems: 'center',
  background: 'var(--sapphire-subtle)',
  color: 'var(--sapphire)',
  fontWeight: 700,
  fontSize: 15,
} as const;

function Avatar({
  src,
  name,
  size,
  className,
}: {
  src: string | null;
  name: string;
  size: number;
  className?: string;
}) {
  if (src) {
    return (
      // Photo URLs are entered by the agency and can point anywhere, so
      // next/image would need an open remotePatterns allowlist to render them.
      // A plain <img> is the honest trade until photos move to R2.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ borderRadius: '50%', objectFit: 'cover' }}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={className}
      style={{
        ...initialsStyle,
        width: size,
        height: size,
        borderRadius: '50%',
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initialsOf(name)}
    </div>
  );
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

const TIER_LABEL: Record<string, string> = {
  t1: 'Tier 1',
  t2: 'Tier 2',
  t3: 'Tier 3',
};

/** Licence dates are stored as instants; only the calendar day matters here. */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function expiryNote(iso: string | null): { text: string; overdue: boolean } | null {
  const formatted = formatDate(iso);
  if (!formatted || !iso) return null;
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: `${formatted} — expired`, overdue: true };
  if (days <= 60) return { text: `${formatted} — ${days} days left`, overdue: true };
  return { text: formatted, overdue: false };
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className={styles.credRow}>
      <span className={styles.smallMuted}>{label}</span>
      <span style={{ marginLeft: 'auto', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function Chips({ items }: { items: string[] | null }) {
  if (!items?.length) return <div className={styles.smallMuted}>—</div>;
  return (
    <div className={styles.chips}>
      {items.map((item) => (
        <span key={item} className={styles.chip}>
          {item}
        </span>
      ))}
    </div>
  );
}

/**
 * Everything the five-step onboarding wizard collected, read back from the
 * database. A pending invite has no profile row yet, so those fields come from
 * the stored draft — either way the dossier shows the same shape.
 */
function Dossier({ row }: { row: AgencyAgentRow }) {
  const legalName = [row.firstName, row.lastName].filter(Boolean).join(' ');
  const expiry = expiryNote(row.licenceExpiry);
  const flags = Object.entries(row.permissionFlags ?? {}).filter(([, on]) => on);

  return (
    <>
      <div className={styles.sectionLabel}>Identity &amp; contact</div>
      <div className={styles.credBox}>
        <Row label="Legal name" value={legalName || null} />
        <Row label="Email" value={row.email} />
        <Row label="Mobile" value={row.phone} />
        <Row label="Joined" value={formatDate(row.joinedAt)} />
      </div>

      <div className={styles.sectionLabel}>Licensing</div>
      <div className={styles.credBox}>
        <Row label="Licence" value={row.licenceNumber ? `#${row.licenceNumber}` : null} />
        <Row label="Class" value={row.licenceClass} />
        <Row
          label="Expires"
          value={
            expiry ? (
              <span style={expiry.overdue ? { color: 'var(--rose)', fontWeight: 600 } : undefined}>
                {expiry.text}
              </span>
            ) : null
          }
        />
      </div>

      <div className={styles.sectionLabel}>Territory</div>
      <Chips items={row.territorySuburbs} />
      {row.territoryRadiusKm !== null ? (
        <div className={styles.smallMuted} style={{ marginTop: 6 }}>
          {row.territoryRadiusKm} km radius
        </div>
      ) : null}

      <div className={styles.sectionLabel}>Commission</div>
      <div className={styles.credBox}>
        <Row label="Tier" value={row.commissionTier ? TIER_LABEL[row.commissionTier] ?? row.commissionTier : null} />
        <Row
          label="Split"
          value={
            row.commissionSplitAgent !== null && row.commissionSplitAgency !== null
              ? `${row.commissionSplitAgent}% agent / ${row.commissionSplitAgency}% agency`
              : null
          }
        />
      </div>

      <div className={styles.sectionLabel}>Specialties</div>
      <Chips items={row.specialties} />

      <div className={styles.sectionLabel}>Languages</div>
      <Chips items={row.languages} />

      {flags.length ? (
        <>
          <div className={styles.sectionLabel}>Permissions</div>
          <Chips items={flags.map(([name]) => name.replace(/[_-]/g, ' '))} />
        </>
      ) : null}

      <div className={styles.sectionLabel}>Status</div>
      <div className={styles.credBox}>
        <Row label="Membership" value={row.status} />
        <Row label="Operational role" value={row.operationalRole} />
        <Row label="Public profile" value={row.publicProfile ? 'Visible' : 'Hidden'} />
      </div>

      {row.bio ? (
        <>
          <div className={styles.sectionLabel}>Bio</div>
          <p className={styles.sub} style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>
            {row.bio}
          </p>
        </>
      ) : null}
    </>
  );
}

export function TeamDirectory({
  agents: rows,
  loadError,
  invites,
}: {
  agents: AgencyAgentRow[];
  loadError?: string | null;
  /** Pending-invite panel, rendered by the server page. */
  invites?: ReactNode;
}) {
  const everyone = useMemo(() => rows.map(mapRow), [rows]);
  // Owner/admin run the agency — they are not part of the sales roster.
  const admins = useMemo(() => everyone.filter((a) => a.isAgencyAdmin), [everyone]);
  const agents = useMemo(() => everyone.filter((a) => !a.isAgencyAdmin), [everyone]);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('all');
  const [selectedId, setSelectedId] = useState(agents[0]?.id ?? '');

  const filtered = agents.filter((a) => {
    if (tab === 'active') return a.status === 'active';
    if (tab === 'invited') return a.status === 'invited';
    return true;
  });

  const selected =
    filtered.find((a) => a.id === selectedId) ??
    filtered[0] ??
    agents[0] ??
    admins[0] ??
    null;

  const tabs = TABS.map((t) => ({
    ...t,
    count:
      t.id === 'all'
        ? agents.length
        : t.id === 'active'
          ? agents.filter((a) => a.status === 'active').length
          : agents.filter((a) => a.status === 'invited').length,
  }));

  return (
    <div className={styles.layout} data-full-bleed>
      <div className={styles.main}>
        <div className={styles.head}>
          <div>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>Agents &amp; Team Directory</h1>
              <span className={styles.verified}>
                <span className={styles.glyphXs} aria-hidden>
                  verified
                </span>
                Live roster
              </span>
            </div>
            <p className={styles.sub}>
              Sales roster from membership + agent_profile. Agency admins are listed separately.
            </p>
          </div>
          <div className={styles.actions}>
            <Link href="/team/onboarding" className={styles.btnPrimary}>
              <span className={styles.glyphSm} aria-hidden>
                person_add
              </span>
              + Add Agent (Onboarding Wizard)
            </Link>
          </div>
        </div>

        {loadError ? (
          <div
            role="alert"
            style={{
              marginBottom: 16,
              padding: '12px 14px',
              borderRadius: 10,
              background: 'color-mix(in srgb, #c62828 10%, transparent)',
              color: '#b71c1c',
              fontSize: 13,
            }}
          >
            {loadError}
          </div>
        ) : null}

        {invites}

        {admins.length ? (
          <div className={styles.card} style={{ padding: '14px 16px', marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-secondary)',
                marginBottom: 10,
              }}
            >
              Agency admin{admins.length > 1 ? 's' : ''}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
              {admins.map((a) => (
                <div
                  key={a.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}
                >
                  <Avatar src={a.avatar} name={a.name} size={32} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {a.role} · {a.email}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.tabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span>{t.label}</span>
              <span className={styles.tabCount}>{t.count}</span>
            </button>
          ))}
        </div>

        <div className={styles.kpiGrid}>
          <div className={styles.kpi}>
            <div className={styles.kpiTop}>
              <span className={styles.kpiLabel}>Total agents</span>
            </div>
            <div className={styles.kpiVal}>
              <span className={styles.kpiNum}>{agents.length}</span>
            </div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiTop}>
              <span className={styles.kpiLabel}>Active</span>
            </div>
            <div className={styles.kpiVal}>
              <span className={styles.kpiNum}>
                {agents.filter((a) => a.status === 'active').length}
              </span>
            </div>
          </div>
          <div className={styles.kpi}>
            <div className={styles.kpiTop}>
              <span className={styles.kpiLabel}>Invited</span>
            </div>
            <div className={styles.kpiVal}>
              <span className={styles.kpiNum}>
                {agents.filter((a) => a.status === 'invited').length}
              </span>
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className={styles.card} style={{ padding: 32, textAlign: 'center' }}>
            <p className={styles.sub} style={{ marginBottom: 12 }}>
              No agents on the roster yet. Run the onboarding wizard to invite your first agent.
            </p>
            <Link href="/team/onboarding" className={styles.btnPrimary}>
              Add first agent
            </Link>
          </div>
        ) : (
          <div className={styles.card}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Licence</th>
                    <th>Territory</th>
                    <th>Status</th>
                    <th>Email</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr
                      key={a.id}
                      className={`${styles.row} ${selected?.id === a.id ? styles.rowSelected : ''}`}
                      onClick={() => setSelectedId(a.id)}
                    >
                      <td>
                        <div className={styles.person}>
                          <div className={styles.avatarWrap}>
                            <Avatar src={a.avatar} name={a.name} size={40} className={styles.avatar} />
                          </div>
                          <div>
                            <div className={styles.name}>{a.name}</div>
                            <div className={styles.role}>{a.role}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={styles.lic}>{a.license}</span>
                      </td>
                      <td>
                        <div className={styles.chips}>
                          {a.suburbs.map((s) => (
                            <span key={s} className={styles.chip}>
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span className={styles.smallMuted}>{a.status}</span>
                      </td>
                      <td>
                        <span className={styles.smallMuted}>{a.email}</span>
                      </td>
                      <td>
                        <span className={aiClass(a.aiTone)}>
                          <span className={styles.glyphXs} aria-hidden>
                            {a.aiIcon}
                          </span>{' '}
                          {a.aiLabel}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {selected ? (
        <aside className={styles.drawer}>
          <div className={styles.drawerInner}>
            <div className={styles.drawerHead}>
              <Avatar
                src={selected.avatar}
                name={selected.name}
                size={48}
                className={styles.drawerAvatar}
              />
              <div>
                <div className={styles.name}>{selected.name}</div>
                <div className={styles.role}>{selected.role}</div>
                <div className={styles.lic}>{selected.license}</div>
              </div>
            </div>

            <Dossier row={selected.row} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
