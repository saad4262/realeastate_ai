export {
  disconnectIntegration,
  IntegrationError,
  integrationResource,
  listIntegrationSlots,
  requireIntegrations,
  resolveIntegration,
  saveConnection,
  tokensForUse,
  type GrantedConnection,
  type IntegrationAccountView,
  type IntegrationCheck,
  type IntegrationRequirement,
  type IntegrationSlot,
  type IntegrationState,
} from './accounts';
export { decryptToken, encryptToken, tokenKeysFromEnv, TokenKeyError, type TokenKeys } from './crypto';
export { signState, verifyState, type OAuthState } from './state';
export {
  adapterFor,
  adapterForTokens,
  isStubToken,
  pkceChallenge,
  pkceVerifier,
  realAdapterFor,
  type RefreshedTokens,
  browserHost,
  completeConnect,
  consoleUrl,
  HOP_PARAM,
  RETURN_PATH,
  returnHop,
  returnUri,
  startConnect,
  STUB_PATH,
  stubEnabled,
  type OAuthAdapter,
  type ReturnOutcome,
  type Surface,
} from './oauth';
export * from './providers';
export { googleAdapter, googleClientFromEnv, type GoogleClient } from './google-oauth';
export { zoomAdapter, zoomClientFromEnv, type ZoomClient } from './zoom-oauth';
export {
  deleteZoomConnections,
  handleZoomWebhook,
  verifyZoomSignature,
  ZOOM_WEBHOOK_MAX_SKEW_MS,
  zoomWebhookSecretFromEnv,
  type ZoomWebhookResponse,
} from './zoom-webhook';
export { ProviderError, type Fetch, type ProviderErrorKind } from './provider-http';
export { disconnectAndRevoke, markExpired, markUsed, RENEW_EARLY_MS, withAccessToken, type ProviderDeps } from './tokens';
export { CALENDAR_EVENTS_URL, eventIdFor, googleCalendarApi, stubCalendarApi, type CalendarApi, type CalendarEventInput, type CalendarEventSeen } from './google-calendar';
export { stubZoomApi, zoomMeetingsApi, type ZoomApi, type ZoomMeetingInput, type ZoomMeetingRef } from './zoom-meetings';
export { fakeFetch } from './fake-fetch';
export { buildMime, gmailApi, gmailError, GMAIL_SEND_URL, stubGmailApi, stubGmailSent, type GmailApi } from './gmail';
// ADR 0076: Outlook, and which mailbox / calendar is active.
export { accountFromIdToken, microsoftAdapter, microsoftClientFromEnv, MICROSOFT_AUTHORIZE_URL, MICROSOFT_TOKEN_URL, type MicrosoftClient } from './microsoft-oauth';
export { outlookCalendarApi, OUTLOOK_EVENTS_URL, stubOutlookCalendarApi } from './outlook-calendar';
export { outlookError, outlookMailApi, OUTLOOK_SEND_URL, stubOutlookMailApi, stubOutlookSent, type OutlookMailApi } from './outlook-mail';
export { chosenProvider, pickActive, purposeOf, PURPOSE_PROVIDERS, PURPOSES, resolveActive, setActiveProvider, type Purpose } from './choice';
