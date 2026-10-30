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

/**
 * A section of the sidebar (ADR 0057). A labelled group has a heading that
 * collapses it; one without a label is always shown and has no heading.
 */
export type NavGroup = {
  label?: string;
  items: NavItem[];
};

export type ShellConfig = {
  /** The assistant home: where "+ New chat", the brand and Recents go. Middleware lands people here. */
  home: string;
  navLabel: string;
  /**
   * The nav, in the brief's order: Daily work · People · Properties · Marketing ·
   * Automation · Knowledge & insights · Money · Settings. Both consoles use the
   * same group names; each lists only pages that exist on its side.
   */
  groups: NavGroup[];
  /** The group that starts open beside the one holding the current page. */
  openByDefault?: string;
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
    groups: [
      {
        items: [
          { href: '/overview', label: 'Overview', icon: 'home' },
          { href: '/ai', label: 'LocalAgent AI', icon: 'smart_toy', badge: '2030', badgeTone: 'blue' },
        ],
      },
      {
        label: 'Daily work',
        items: [
          { href: '/leads', label: 'Leads', icon: 'filter_alt', count: 'newOffers' },
          { href: '/inbox', label: 'Inbox', icon: 'mail', count: 'unreadMail', countLabel: 'unread' },
          { href: '/missed-calls', label: 'Missed calls', icon: 'phone_missed' },
          { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
          { href: '/messages', label: 'Team messages', icon: 'forum', count: 'unreadTeam', countLabel: 'unread' },
        ],
      },
      {
        label: 'People',
        items: [
          { href: '/customers', label: 'Customers', icon: 'contacts' },
          { href: '/team', label: 'Agents & Team', icon: 'groups' },
        ],
      },
      {
        label: 'Properties',
        items: [
          // ADR 0065: every address the agency has a record of, with everything on it.
          { href: '/properties', label: 'Properties', icon: 'location_city' },
          { href: '/live-listings', label: 'Listings', icon: 'real_estate_agent' },
          // ADR 0063: every sale from appraisal to settlement.
          { href: '/pipeline', label: 'Pipeline', icon: 'view_kanban' },
        ],
      },
      {
        label: 'Marketing',
        items: [
          { href: '/bulk-email', label: 'Bulk email', icon: 'forward_to_inbox' },
          { href: '/marketing', label: 'Marketing & Reviews', icon: 'campaign' },
        ],
      },
      // Workflows are the Automations tab of Skills (ADR 0058).
      { label: 'Automation', items: [{ href: '/skills', label: 'Skills', icon: 'auto_awesome' }] },
      {
        label: 'Knowledge & insights',
        items: [
          { href: '/knowledge', label: 'Knowledge base', icon: 'menu_book' },
          { href: '/projects', label: 'Projects', icon: 'folder_open' },
          // Not /site-activity: that is the admin console's, and the agency host sends it home.
          { href: '/insights', label: 'Insights', icon: 'analytics' },
        ],
      },
      // ADR 0064: commission earned and expected; trust accounting stays in the agency's trust software.
      { label: 'Money', items: [{ href: '/finance', label: 'Finance', icon: 'account_balance' }] },
      {
        label: 'Settings',
        items: [
          { href: '/settings/integrations', label: 'Connectors', icon: 'hub' },
          { href: '/settings', label: 'Settings', icon: 'settings' },
        ],
      },
    ],
    openByDefault: 'Daily work',
    brandFallback: 'No agency yet',
    omniPlaceholder: 'Search agent name, REINSW licence, suburb specialist, or sales volume...',
    ticker: true,
    helpHref: '/settings',
  },
  agent: {
    home: '/assistant',
    navLabel: 'Agent',
    // The agency's groups, holding the agent's own pages. Offers is not here: it was a link to
    // nothing, and offers are worked in Leads (ADR 0057).
    groups: [
      {
        label: 'Daily work',
        items: [
          { href: '/my-leads', label: 'Leads', icon: 'person_search' },
          { href: '/my-inbox', label: 'Inbox', icon: 'mail', count: 'unreadMail', countLabel: 'unread' },
          { href: '/my-missed-calls', label: 'Missed calls', icon: 'phone_missed' },
          { href: '/my-calendar', label: 'Calendar', icon: 'event' },
          { href: '/my-messages', label: 'Team messages', icon: 'forum', count: 'unreadTeam', countLabel: 'unread' },
        ],
      },
      { label: 'People', items: [{ href: '/my-contacts', label: 'Contacts', icon: 'contacts' }] },
      {
        label: 'Properties',
        items: [
          { href: '/my-properties', label: 'Properties', icon: 'location_city' },
          { href: '/listings', label: 'My Listings', icon: 'home_work' },
          { href: '/my-pipeline', label: 'Pipeline', icon: 'view_kanban' },
        ],
      },
      {
        label: 'Marketing',
        items: [
          { href: '/my-bulk-email', label: 'Bulk email', icon: 'forward_to_inbox' },
          { href: '/my-reviews', label: 'Agency reviews', icon: 'reviews' },
        ],
      },
      { label: 'Automation', items: [{ href: '/my-skills', label: 'Skills', icon: 'auto_awesome' }] },
      {
        label: 'Knowledge & insights',
        items: [
          { href: '/my-knowledge', label: 'Knowledge base', icon: 'menu_book' },
          { href: '/my-projects', label: 'Projects', icon: 'folder_open' },
        ],
      },
      { label: 'Money', items: [{ href: '/my-commission', label: 'My commission', icon: 'account_balance' }] },
      { label: 'Settings', items: [{ href: '/my-integrations', label: 'Connectors', icon: 'hub' }] },
    ],
    openByDefault: 'Daily work',
    brandFallback: 'Agent desk',
    omniPlaceholder: 'Search your listings, contacts or suburbs...',
    ticker: false,
  },
  // The platform admin console (ADR 0049): its own lean shell (components/admin/admin-shell.tsx) reads this nav.
  admin: {
    home: '/platform',
    navLabel: 'Platform',
    // One group without a heading: six pages need no sections (ADR 0057).
    groups: [
      {
        items: [
          { href: '/platform', label: 'Overview', icon: 'monitoring' },
          { href: '/agencies', label: 'Agencies', icon: 'apartment' },
          { href: '/agents', label: 'Agents', icon: 'groups' },
          { href: '/users', label: 'Users', icon: 'person_search' },
          { href: '/site-activity', label: 'Site activity', icon: 'travel_explore' },
          { href: '/emails', label: 'Emails', icon: 'mail' },
        ],
      },
    ],
    brandFallback: 'Platform admin',
    omniPlaceholder: 'Search agencies...',
    ticker: false,
  },
};
