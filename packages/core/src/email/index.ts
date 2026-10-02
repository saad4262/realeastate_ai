export {
  dryRunTransport,
  EmailError,
  fakeTransport,
  type EmailAddress,
  type EmailMessage,
  type EmailTransport,
  type FakeTransport,
  type MarketingMessage,
  type SendResult,
  type TransactionalMessage,
} from './transport';

export {
  mailerFromEnv,
  noticeMailFromEnv,
  requireResendTransport,
  requireSenderIdentity,
  resendTransport,
  type SenderIdentity,
} from './resend-transport';

export {
  requireUnsubscribeSecret,
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
  type UnsubscribeClaim,
} from './unsubscribe';

export {
  buildScheduleDigestEmail,
  escapeHtml,
  requireSenderFooter,
  templateSummary,
  type ScheduleDigestInput,
} from './schedule-digest';

export {
  buildPrivateOfferEmail,
  type PrivateOfferEmailInput,
} from './private-offer';

export {
  buildAgentInviteEmail,
  buildLeadNoticeEmail,
  type AgentInviteEmailInput,
  type LeadNoticeEmailInput,
} from './team-notices';
