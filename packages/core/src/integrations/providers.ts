/**
 * What each integration is, who may own it, and what it asks for and why
 * (ADR 0020). Pure — the settings page and the "Connect X first" card import
 * it. The owner types are also a CHECK in migration 0024; keep them equal.
 *
 * The scope names are PROVISIONAL until Phase 3b connects the real providers:
 * they are verified against Google's and Zoom's own documentation then, and
 * this file is the one place that changes.
 */

export const INTEGRATION_PROVIDERS = ['google_calendar', 'zoom', 'google_sheets', 'google_reviews'] as const;
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
      { scope: 'https://www.googleapis.com/auth/calendar.events', why: 'To add, move and cancel the events for appointments you book here. Nothing else in your calendar is read or changed.' },
      { scope: 'openid email', why: 'To show which Google account is connected.' },
    ],
  },
  zoom: {
    label: 'Zoom',
    purpose: 'A Zoom appointment creates its own meeting link. Your own Zoom is used first, then the agency’s.',
    ownerTypes: ['user', 'agency'],
    scopes: [
      { scope: 'meeting:write:meeting', why: 'To create, move and cancel the meeting for a Zoom appointment.' },
      { scope: 'user:read:user', why: 'To show which Zoom account is connected.' },
    ],
  },
  google_sheets: {
    label: 'Google Sheets',
    purpose: 'Import listings from a sheet you choose. Your sheets are only read, never changed.',
    ownerTypes: ['user', 'agency'],
    scopes: [
      { scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', why: 'To read the sheet you pick for an import. Sheets are never changed.' },
      { scope: 'openid email', why: 'To show which Google account is connected.' },
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

/** Which required scopes a grant is missing. Empty means all of them were granted. */
export function missingScopes(provider: IntegrationProvider, granted: readonly string[]): string[] {
  const have = new Set(granted.flatMap((g) => g.split(' ')));
  return requiredScopes(provider).filter((s) => !have.has(s));
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
