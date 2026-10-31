/**
 * What each integration is, who may own it, and what it asks for and why
 * (ADR 0020). Pure — the settings page and the "Connect X first" card import
 * it. The owner types are also a CHECK in migration 0024; keep them equal.
 *
 * Google Calendar and Zoom scopes were checked against Google's and Zoom's
 * own documentation on 2026-10-06 (Phase 3b) and are the least each feature
 * needs. Gmail's scope was checked on 2026-10-06 (Phase 6). Sheets' on 2026-10-13 (ADR 0029
 * amendment: `drive.file`, the Picker). Reviews is still PROVISIONAL until it is built.
 * This file is the one place a scope changes.
 */

export const INTEGRATION_PROVIDERS = ['google_calendar', 'zoom', 'google_sheets', 'google_reviews', 'gmail', 'outlook_mail', 'outlook_calendar'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export type IntegrationOwnerType = 'user' | 'agency';
export type IntegrationStatus = 'connected' | 'expired' | 'error' | 'permission_missing';

export type ProviderInfo = {
  label: string;
  /** One sentence: what connecting it does for you. */
  purpose: string;
  /** Who may own a connection, in the order requireIntegrations tries them. */
  ownerTypes: readonly IntegrationOwnerType[];
  /** Every scope requested, each with the reason shown on the settings card. */
  scopes: readonly { scope: string; why: string }[];
};

export const PROVIDERS: Record<IntegrationProvider, ProviderInfo> = {
  google_calendar: {
    label: 'Google Calendar',
    purpose: 'Appointments you book here appear in your Google Calendar and stay in step with it.',
    ownerTypes: ['user'],
    scopes: [
      // calendar.events.owned, not calendar.events: only calendars the person owns,
      // which is where we write — still create, change, delete and read back.
      { scope: 'https://www.googleapis.com/auth/calendar.events.owned', why: 'To add, move and cancel the events for appointments you book here, and to notice if you move one in Google. Other events are never read or changed.' },
      { scope: 'openid email', why: 'To show which Google account is connected.' },
    ],
  },
  zoom: {
    label: 'Zoom',
    purpose: 'A Zoom appointment creates its own meeting link, on your own Zoom — so you are its host.',
    ownerTypes: ['user', 'agency'],
    scopes: [
      { scope: 'meeting:write:meeting', why: 'To create the meeting for a Zoom appointment.' },
      { scope: 'meeting:update:meeting', why: 'To move that meeting when the appointment is rescheduled.' },
      { scope: 'meeting:delete:meeting', why: 'To delete that meeting when the appointment is cancelled.' },
      { scope: 'user:read:user', why: 'To show which Zoom account is connected.' },
    ],
  },
  google_sheets: {
    label: 'Google Sheets',
    purpose: 'Import from a sheet you pick in Google’s own file picker. Only the files you pick can be opened, and they are only read.',
    ownerTypes: ['user', 'agency'],
    scopes: [
      // drive.file (ADR 0029 amendment, 2026-10-13): only files the person picks in the Picker —
      // never their other sheets or files. Google's "non-sensitive" class. The pasted-link route
      // (any sheet, spreadsheets.readonly) is pending Google's verification.
      { scope: 'https://www.googleapis.com/auth/drive.file', why: 'To open only the sheets you pick in Google’s file picker, to import them. Nothing else in your Drive can be seen, and nothing is changed.' },
      { scope: 'openid email', why: 'To show which Google account is connected.' },
    ],
  },
  gmail: {
    label: 'Gmail (send only)',
    purpose: 'Emails you write to a contact here are sent from your Gmail and sit in its Sent folder. Your mailbox is never read.',
    ownerTypes: ['user', 'agency'],
    scopes: [
      // gmail.send only (ADR 0026, checked 2026-10-06): send as the account, nothing else —
      // no reading, listing, labels or deleting. A Google "sensitive" scope, not "restricted".
      { scope: 'https://www.googleapis.com/auth/gmail.send', why: 'To send the emails you write here from your Gmail. It cannot read, list or delete anything in your mailbox.' },
      { scope: 'openid email', why: 'To show which Google account is connected, and send from that address.' },
    ],
  },
  // ADR 0076 (checked against learn.microsoft.com 2026-10-31): least privilege for sendMail and for events,
  // for work/school and personal accounts alike. offline_access gives the refresh token.
  outlook_mail: {
    label: 'Outlook (send only)',
    purpose: 'Emails you write to a contact here are sent from your Outlook and sit in its Sent Items. Your mailbox is never read.',
    ownerTypes: ['user', 'agency'],
    scopes: [
      { scope: 'https://graph.microsoft.com/Mail.Send', why: 'To send the emails you write here from your Outlook. It cannot read, list or delete anything in your mailbox.' },
      { scope: 'https://graph.microsoft.com/User.Read', why: 'To show which Microsoft account is connected, and send from that address.' },
      { scope: 'openid email offline_access', why: 'To stay connected without asking you to sign in every hour.' },
    ],
  },
  outlook_calendar: {
    label: 'Outlook Calendar',
    purpose: 'Appointments you book here appear in your Outlook Calendar and stay in step with it.',
    ownerTypes: ['user'],
    scopes: [
      { scope: 'https://graph.microsoft.com/Calendars.ReadWrite', why: 'To add, move and cancel the events for appointments you book here, and to notice if you move one in Outlook. Only those events are read or changed.' },
      { scope: 'https://graph.microsoft.com/User.Read', why: 'To show which Microsoft account is connected.' },
      { scope: 'openid email offline_access', why: 'To stay connected without asking you to sign in every hour.' },
    ],
  },
  google_reviews: {
    label: 'Google Business Profile (reviews)',
    purpose: "Show the agency's Google rating and reviews, and match a review to a contact once confirmed.",
    ownerTypes: ['agency'],
    scopes: [
      { scope: 'https://www.googleapis.com/auth/business.manage', why: "To read the agency's reviews and rating. Google offers reviews only under this permission; nothing is posted or changed." },
    ],
  },
};

/** The scopes as one list, split where a provider takes several in one string. */
export function requiredScopes(provider: IntegrationProvider): string[] {
  return PROVIDERS[provider].scopes.flatMap((s) => s.scope.split(' '));
}

/**
 * Google answers a request for `email` / `profile` with the long names in the
 * granted list — the same permission under two spellings.
 */
const SCOPE_ALIASES: Record<string, string> = {
  'https://www.googleapis.com/auth/userinfo.email': 'email',
  'https://www.googleapis.com/auth/userinfo.profile': 'profile',
};

/** ADR 0076: Microsoft's providers. They share one Entra app and Microsoft's own scope spelling. */
export const MICROSOFT_PROVIDERS: readonly IntegrationProvider[] = ['outlook_mail', 'outlook_calendar'];
const GRAPH = 'https://graph.microsoft.com/';
/** Microsoft does not reliably list these in a token's `scope`; they are asked for, not checked. */
const MICROSOFT_UNREPORTED = new Set(['openid', 'email', 'profile', 'offline_access']);

/** One spelling per scope: Google's long OIDC names, and Microsoft's Graph scopes with or without the prefix, any case. */
function scopeKey(provider: IntegrationProvider, s: string): string {
  if (!MICROSOFT_PROVIDERS.includes(provider)) return SCOPE_ALIASES[s] ?? s;
  const t = s.toLowerCase();
  return t.startsWith(GRAPH) ? t.slice(GRAPH.length) : t;
}

/** Which required scopes a grant is missing. Empty means all of them were granted. */
export function missingScopes(provider: IntegrationProvider, granted: readonly string[]): string[] {
  const have = new Set(granted.flatMap((g) => g.split(' ')).map((s) => scopeKey(provider, s)));
  return requiredScopes(provider).filter(
    (s) => !(MICROSOFT_PROVIDERS.includes(provider) && MICROSOFT_UNREPORTED.has(s)) && !have.has(scopeKey(provider, s)),
  );
}

export const STATUS_LABELS: Record<IntegrationStatus | 'not_connected', string> = {
  connected: 'Connected',
  expired: 'Expired — reconnect',
  error: 'Error',
  permission_missing: 'Permission missing',
  not_connected: 'Not connected',
};

export function isIntegrationProvider(v: unknown): v is IntegrationProvider {
  return (INTEGRATION_PROVIDERS as readonly string[]).includes(v as string);
}
