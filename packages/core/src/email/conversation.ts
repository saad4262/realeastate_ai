import { leadDetailsHtml, leadDetailsText, type LeadDetails } from './lead-details';
import { escapeHtml, requireSenderFooter } from './schedule-digest';
import { type EmailAddress, type TransactionalMessage } from './transport';

/**
 * The two emails a conversation sends (docs/adr/0016).
 *
 * Both are transactional — a reply to somebody who wrote to the agency, and a
 * notice to an agent that the buyer wrote back — so neither carries an
 * unsubscribe header. Sender identity and the postal address are still in both
 * parts, through `requireSenderFooter`.
 *
 * Nothing here is model-written. The body of a reply is what a person typed.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

/** Paragraphs from plain text, every character escaped. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (block) =>
        `<p style="font:400 15px/1.6 ${FONT};color:#1a1a1a;margin:0 0 14px;">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

/** "Re: " once, however many times a thread has gone back and forth. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

// ── A message from the agency to the person it is talking to ───────────────

export type ConversationEmailInput = {
  to: EmailAddress;
  /** The platform's sending address, with the agent and agency as its name. */
  from: { email: string; name: string };
  replyTo: EmailAddress;
  postalAddress: string;
  subject: string;
  /** Exactly what the agent wrote. */
  body: string;
  /** Signed off with — "Sara Khan", "Ray White Pakenham". */
  authorName: string;
  agencyName: string;
  /** The buyer's message this answers, when we have its Message-ID. */
  threading?: { inReplyTo: string; references: string[] };
  /** The conversation on the public site — one plain link, under the sign-off. */
  viewUrl?: string;
};

/**
 * Looks like an email from a person, because it is one.
 *
 * Deliberately no button, no card, no banner: the buyer is mid-conversation
 * with an agent, and a templated look reads as marketing and gets filed as it.
 * The only platform line is the small footer, which the Spam Act requires.
 */
export function buildConversationEmail(input: ConversationEmailInput): TransactionalMessage {
  requireSenderFooter(input.from, input.postalAddress, 'conversation');

  const signOff = `${input.authorName}\n${input.agencyName}`;
  const why = `Sent by ${input.agencyName} in reply to your enquiry. Reply to this email to answer them.`;

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:16px;background:#ffffff;">
  <div style="max-width:620px;">
    ${paragraphs(input.body)}
    <p style="font:400 15px/1.6 ${FONT};color:#1a1a1a;margin:18px 0 0;">${escapeHtml(signOff).replace(/\n/g, '<br>')}</p>
    ${
      input.viewUrl
        ? `<p style="font:400 13px/1.6 ${FONT};margin:18px 0 0;"><a href="${escapeHtml(input.viewUrl)}" style="color:#0b3d2e;">View this conversation on the website</a></p>`
        : ''
    }
    <p style="font:400 12px/1.6 ${FONT};color:#8c8577;margin:28px 0 0;border-top:1px solid #ece7dd;padding-top:12px;">
      ${escapeHtml(why)}<br>
      ${escapeHtml(input.from.name)}, ${escapeHtml(input.postalAddress)}
    </p>
  </div>
</body>
</html>`;

  const text = [
    input.body,
    '',
    signOff,
    '',
    ...(input.viewUrl ? [`View this conversation on the website: ${input.viewUrl}`, ''] : []),
    '---',
    why,
    `${input.from.name}, ${input.postalAddress}`,
  ].join('\n');

  return {
    kind: 'transactional',
    to: input.to,
    from: input.from,
    replyTo: input.replyTo,
    subject: replySubject(input.subject),
    html,
    text,
    tags: { kind: 'conversation' },
    ...(input.threading ? { threading: input.threading } : {}),
  };
}

// ── "They wrote back", to the agent ────────────────────────────────────────

export type ReplyNoticeEmailInput = {
  to: EmailAddress;
  from: { email: string; name: string };
  /** The thread's signed address — answering this email answers the buyer. */
  replyTo: EmailAddress | null;
  postalAddress: string;
  subject: string;
  /** Who wrote — the buyer's name or address. */
  writer: string;
  /** The new part of what they wrote, quoted history already cut. */
  body: string;
  /** The conversation in the recipient's own inbox. */
  threadUrl: string;
  /** What the lead is — property, offer, ad, person — under the reply. */
  details?: LeadDetails;
};

export function buildReplyNoticeEmail(input: ReplyNoticeEmailInput): TransactionalMessage {
  requireSenderFooter(input.from, input.postalAddress, 'reply notice');

  const heading = `${input.writer} replied`;
  const how = input.replyTo
    ? 'Reply to this email and your answer goes straight to them, or open the conversation.'
    : 'Open the conversation to answer them.';
  const why = 'Sent because somebody replied in a conversation you can see.';

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f7f4ef;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ef;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d9d2c5;border-radius:12px;padding:28px;">
        <tr><td>
          <h1 style="font:600 20px/1.3 ${FONT};color:#1a1a1a;margin:0;">${escapeHtml(heading)}</h1>
          <div style="font:400 14px/1.5 ${FONT};color:#5c5c5c;margin:6px 0 18px;">${escapeHtml(input.subject)}</div>
          ${paragraphs(input.body)}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;">
            <tr><td style="background:#0b3d2e;border-radius:6px;">
              <a href="${escapeHtml(input.threadUrl)}"
                 style="display:inline-block;padding:12px 22px;font:600 15px/1 ${FONT};color:#f7f4ef;text-decoration:none;">
                Open the conversation
              </a>
            </td></tr>
          </table>
          <div style="font:400 13px/1.5 ${FONT};color:#5c5c5c;margin-top:14px;">${escapeHtml(how)}</div>
          ${
            input.details
              ? `<div style="font:700 11px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:#8c8577;margin-top:26px;">About this lead</div>${leadDetailsHtml(input.details)}`
              : ''
          }
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;padding:20px 8px 0;">
        <tr><td style="font:400 12px/1.6 ${FONT};color:#8c8577;">
          ${escapeHtml(why)}<br><br>
          ${escapeHtml(input.from.name)}, ${escapeHtml(input.postalAddress)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    heading,
    input.subject,
    '',
    input.body,
    '',
    `Open the conversation: ${input.threadUrl}`,
    how,
    '',
    ...(input.details ? ['About this lead', ...leadDetailsText(input.details), ''] : []),
    '---',
    why,
    `${input.from.name}, ${input.postalAddress}`,
  ].join('\n');

  return {
    kind: 'transactional',
    to: input.to,
    from: input.from,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: replySubject(input.subject),
    html,
    text,
    tags: { kind: 'conversation-notice' },
  };
}
