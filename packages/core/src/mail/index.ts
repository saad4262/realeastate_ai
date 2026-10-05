/**
 * Email conversations in the app — the console inbox, the buyer's messages
 * page, and the inbound webhook. See docs/adr/0016.
 */
export {
  agencyMailAddress,
  bareAddress,
  mailConfigFromEnv,
  parseAgencyMailAddress,
  parseThreadReplyAddress,
  threadReplyAddress,
  type MailConfig,
} from './address';
export { htmlToText, snippet, stripQuotedReply } from './body';
export {
  MAIL_FOLDERS,
  MAX_REPLY_LENGTH,
  parseMailFolder,
  receivedEventSchema,
  receivedEmailSchema,
  replyInputSchema,
  type AttachmentNote,
  type MailFolder,
  type ReceivedEmail,
  type ReplyInput,
} from './mail-schema';
export {
  getMailThread,
  listMailThreads,
  markThreadRead,
  MailError,
  mayReadThread,
  maySendOnThread,
  threadResource,
  type ListThreadsOptions,
  type MailMessageView,
  type MailThreadPage,
  type MailThreadRow,
  type MailThreadView,
  type ThreadAccessFacts,
} from './threads';
export {
  deliverOutbound,
  mailDepsFromEnv,
  retryFailedMessage,
  sendThreadReply,
  type MailDeps,
  type SendOutcome,
} from './send';
export {
  fetchReceivedEmail,
  ingestReceivedEmail,
  routeRecipients,
  type IngestOutcome,
} from './inbound';
export { notifyThreadReply, type ThreadNoticeDeps } from './notices';
export {
  getCustomerThread,
  listCustomerThreads,
  replyAsCustomer,
  type CustomerIdentity,
  type CustomerMessage,
  type CustomerThreadList,
  type CustomerThreadRow,
  type CustomerThreadView,
} from './customer';
export { EMAIL_FRAME_SANDBOX, sandboxedEmailDocument } from './sandbox';
export { handleInboundWebhook, type InboundResponse } from './webhook-handler';
export { verifyResendWebhook, WEBHOOK_TOLERANCE_SECONDS, type WebhookHeaders } from './webhook';
export {
  confirmEmailVerification,
  conversationLink,
  provenAddress,
  readEmailVerification,
  sendEmailVerification,
  signEmailVerification,
  verifySecretFromEnv,
} from './verify-email';
export { pullReceivedMail, syncReceivedEmails, type PullResult, type SyncResult } from './sync';
