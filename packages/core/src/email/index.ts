export {
  dryRunTransport,
  EmailError,
  fakeTransport,
  type EmailAddress,
  type EmailMessage,
  type EmailTransport,
  type FakeTransport,
  type SendResult,
} from './transport';

export {
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
  templateSummary,
  type ScheduleDigestInput,
} from './schedule-digest';
