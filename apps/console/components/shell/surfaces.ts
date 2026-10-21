/**
 * What differs between the two consoles' chrome — and nothing else does.
 *
 * agents.* and agency.* are one app (CLAUDE.md #9), so they share one shell
 * (console-shell.tsx) and one stylesheet; this is the only place the two
 * sides say different things. Which pages exist, what each person may do on
 * them and what the assistant may do for them are still decided per request
 * by can() — none of that lives here.
 *
 * Plain data, no 'use client': read by the server shell and the client nav.
 */

export type ShellSurface = 'agency' | 'agent' | 'admin';

/** The chrome's counts a nav item may show as a badge — all from SQL, already narrowed by can(). */
export type NavCount = 'newOffers' | 'unreadMail' | 'unreadTeam';

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  count?: NavCount;
  /** Leads' offer badge is a number on its own; the unread ones are announced as "N unread". */
  countLabel?: 'unread';
  badge?: string;
  badgeTone?: 'blue';
};

export type ShellConfig = {
  /** The assistant home: where "+ New chat", the brand and Recents go. Middleware lands people here. */
  home: string;
  navLabel: string;
  /** Shown at all times. */
  primary: NavItem[];
  /** Behind More. */
  more: NavItem[];
  /** The brand's second line before the agency name arrives, or without one. */
  brandFallback: string;
  omniPlaceholder: string;
  /** The agency summary strip in the top bar — agency-wide counts, so agency side only. */
  ticker: boolean;
  helpHref?: string;
};

export const SHELLS: Record<ShellSurface, ShellConfig> = {
  agency: {
    home: '/overview',
    navLabel: 'Agency',
    primary: [
      { href: '/leads', label: 'Leads', icon: 'filter_alt', count: 'newOffers' },
      { href: '/inbox', label: 'Inbox', icon: 'mail', count: 'unreadMail', countLabel: 'unread' },
      { href: '/projects', label: 'Projects', icon: 'folder_open' },
      { href: '/settings/integrations', label: 'Connectors', icon: 'hub' },
    ],
    more: [
      { href: '/live-listings', label: 'Listings', icon: 'real_estate_agent' },
      { href: '/messages', label: 'Team messages', icon: 'forum', count: 'unreadTeam', countLabel: 'unread' },
      { href: '/team', label: 'Agents & Team', icon: 'groups' },
      { href: '/customers', label: 'Customers', icon: 'contacts' },
      { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
      { href: '/marketing', label: 'Marketing & Reviews', icon: 'campaign' },
      { href: '/site-activity', label: 'Insights', icon: 'analytics' },
      { href: '/skills', label: 'Skills', icon: 'auto_awesome' },
      { href: '/workflows', label: 'Workflows', icon: 'account_tree' },
      { href: '/bulk-email', label: 'Bulk email', icon: 'forward_to_inbox' },
      { href: '/ai', label: 'LocalAgent AI', icon: 'smart_toy', badge: '2030', badgeTone: 'blue' },
      { href: '/finance', label: 'Finance & Trust', icon: 'account_balance' },
      { href: '/settings', label: 'Settings', icon: 'settings' },
    ],
    brandFallback: 'No agency yet',
    omniPlaceholder: 'Search agent name, REINSW licence, suburb specialist, or sales volume...',
    ticker: true,
    helpHref: '/settings',
  },
  agent: {
    home: '/assistant',
    navLabel: 'Agent',
    primary: [
      { href: '/listings', label: 'My Listings', icon: 'home_work' },
      { href: '/my-leads', label: 'Leads', icon: 'person_search' },
      { href: '/my-inbox', label: 'Inbox', icon: 'mail', count: 'unreadMail', countLabel: 'unread' },
      { href: '/my-projects', label: 'Projects', icon: 'folder_open' },
    ],
    more: [
      { href: '/my-messages', label: 'Team messages', icon: 'forum', count: 'unreadTeam', countLabel: 'unread' },
      { href: '/my-contacts', label: 'Contacts', icon: 'contacts' },
      { href: '/my-calendar', label: 'Calendar', icon: 'event' },
      { href: '#', label: 'Offers', icon: 'handshake' },
      { href: '/my-skills', label: 'Skills', icon: 'auto_awesome' },
      { href: '/my-workflows', label: 'Workflows', icon: 'account_tree' },
      { href: '/my-bulk-email', label: 'Bulk email', icon: 'forward_to_inbox' },
      { href: '/my-reviews', label: 'Agency reviews', icon: 'reviews' },
      { href: '/my-integrations', label: 'Connectors', icon: 'hub' },
    ],
    brandFallback: 'Agent desk',
    omniPlaceholder: 'Search your listings, contacts or suburbs...',
    ticker: false,
  },
  // The platform admin console (ADR 0049): its own lean shell (components/admin/admin-shell.tsx) reads this nav.
  admin: {
    home: '/platform',
    navLabel: 'Platform',
    primary: [
      { href: '/platform', label: 'Overview', icon: 'monitoring' },
      { href: '/agencies', label: 'Agencies', icon: 'apartment' },
      { href: '/agents', label: 'Agents', icon: 'groups' },
      { href: '/users', label: 'Users', icon: 'person_search' },
      { href: '/site-activity', label: 'Site activity', icon: 'travel_explore' },
    ],
    more: [],
    brandFallback: 'Platform admin',
    omniPlaceholder: 'Search agencies...',
    ticker: false,
  },
};
