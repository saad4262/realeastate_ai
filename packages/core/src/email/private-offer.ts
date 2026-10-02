import { escapeHtml, requireSenderFooter } from './schedule-digest';
import { type TransactionalMessage } from './transport';

/**
 * "Somebody has made an offer on an address you sold."
 *
 * The one thing that tells an agency a private offer exists. There is no Leads
 * screen yet, so this email IS the routing — which is why the figure, the
 * address and the contact details are all in the body rather than behind a link,
 * and why the subject line carries the address.
 *
 * ## Transactional, and what that means here
 *
 * No unsubscribe header. This is not bulk mail somebody subscribed to; it
 * notifies a business that an offer has been made to it, which is doubtful as a
 * "commercial electronic message" under s.6 at all. See `TransactionalMessage`
 * for the full reasoning and for why inventing an unsubscribe URL would be
 * actively harmful.
 *
 * Sender identity and a postal address are still required, through the same
 * `requireSenderFooter` the digest uses. That half of the Act is cheap and
 * correct on any business mail.
 *
 * ## The figure
 *
 * `amount` is the visitor's own number, formatted for display and never
 * recomputed, compared or estimated (#4). Nothing in this file does arithmetic.
 * The agency needs to read exactly what was offered, so the formatted string and
 * the raw digits are both derived from the one value the visitor typed.
 */
export type PrivateOfferEmailInput = {
  to: { email: string; name?: string };
  from: { email: string; name: string };
  /** Spam Act s.17 — a real postal address, in the footer, in both parts. */
  postalAddress: string;
  /** The address the offer is about, already formatted. */
  propertyAddress: string;
  /** What they offered, in dollars, exactly as they entered it. */
  amount: number;
  /** Who made it. The email comes from their signed-in account, not a form field. */
  offeredBy: { name: string; email: string; phone: string | null };
  message: string;
  /** Where the agency can see the property this is about. */
  propertyUrl: string;
};

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

export function buildPrivateOfferEmail(input: PrivateOfferEmailInput): TransactionalMessage {
  requireSenderFooter(input.from, input.postalAddress, 'private offer');

  const figure = AUD.format(input.amount);
  const subject = `Private offer of ${figure} — ${input.propertyAddress}`;

  const phoneLine = input.offeredBy.phone
    ? `<br>Phone: <a href="tel:${escapeHtml(input.offeredBy.phone)}" style="color:#0b3d2e;">${escapeHtml(input.offeredBy.phone)}</a>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f7f4ef;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ef;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d9d2c5;border-radius:12px;padding:28px;">
        <tr><td>
          <h1 style="font:600 20px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;margin:0;">
            A private offer on ${escapeHtml(input.propertyAddress)}
          </h1>
          <div style="font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5c5c5c;margin-top:4px;">
            You are receiving this because your agency sold this property. It is
            not currently listed.
          </div>

          <div style="font:600 28px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0b3d2e;margin-top:22px;">
            ${escapeHtml(figure)}
          </div>

          <p style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;margin:18px 0 0;white-space:pre-wrap;">${escapeHtml(input.message)}</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;">
            <tr><td style="padding:16px 0;border-top:1px solid #ece7dd;font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
              <strong style="font-weight:600;">${escapeHtml(input.offeredBy.name)}</strong><br>
              <a href="mailto:${escapeHtml(input.offeredBy.email)}" style="color:#0b3d2e;">${escapeHtml(input.offeredBy.email)}</a>${phoneLine}
            </td></tr>
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;">
            <tr><td style="background:#0b3d2e;border-radius:6px;">
              <a href="${escapeHtml(input.propertyUrl)}"
                 style="display:inline-block;padding:12px 22px;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f7f4ef;text-decoration:none;">
                View the property
              </a>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;padding:20px 8px 0;">
        <tr><td style="font:400 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#8c8577;">
          Sent because an offer was made on a property your agency sold.<br><br>
          ${escapeHtml(input.from.name)}, ${escapeHtml(input.postalAddress)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  /**
   * The same information, in the order somebody reading plain text needs it.
   * Sender identity appears here too — in both parts, or in neither.
   */
  const text = [
    `A private offer on ${input.propertyAddress}`,
    '',
    `Offer: ${figure}`,
    '',
    input.message,
    '',
    'From:',
    input.offeredBy.name,
    input.offeredBy.email,
    input.offeredBy.phone,
    '',
    `View the property: ${input.propertyUrl}`,
    '',
    '---',
    'Sent because an offer was made on a property your agency sold. This property is not currently listed.',
    `${input.from.name}, ${input.postalAddress}`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    // Not bulk mail and not subscribed to, so no unsubscribe header. The word is
    // typed here on purpose — see TransactionalMessage.
    kind: 'transactional',
    to: input.to,
    from: input.from,
    subject,
    html,
    text,
    tags: { kind: 'private-offer' },
  };
}
