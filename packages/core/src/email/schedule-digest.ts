import { priceLabel, specLine } from '../listings/format';
import type { PublicListingSummary } from '../listings/search-listings';
import { EmailError, type EmailMessage } from './transport';

/** The one escape. Every interpolated value goes through it. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** How many listings the email itself shows before sending people to the page. */
const EMAIL_LISTING_LIMIT = 5;

export type ScheduleDigestInput = {
  to: { email: string; name?: string };
  from: { email: string; name: string };
  /** Spam Act s.17 — a real postal address, in the footer, in both parts. */
  postalAddress: string;
  scheduleName: string;
  /** Server-authored from the frozen query. Never model-written, never parsed back. */
  description: string;
  /** From SQL. Every figure in this email comes from one of these two. */
  matched: number;
  newCount: number;
  listings: PublicListingSummary[];
  /** The model's paragraph, or null. Carries no figures — see packages/ai. */
  summary: string | null;
  summarySource: 'model' | 'template' | 'none';
  /** Absolute. `savedQueryToPath` gives the path; the caller adds the origin. */
  resultsUrl: string;
  unsubscribeUrl: string;
};

/**
 * The sentence used when the model did not write one.
 *
 * Built from the same integers the heading uses, so the email is never
 * missing its point — a budget refusal or a rejected summary costs prose,
 * not information.
 */
export function templateSummary(input: {
  newCount: number;
  matched: number;
  description: string;
}): string {
  if (input.newCount > 0) {
    const s = input.newCount === 1 ? '' : 's';
    return `${input.newCount} new listing${s} since we last looked, out of ${input.matched} matching ${input.description}.`;
  }
  return `No new listings since we last looked. ${input.matched} still match ${input.description}.`;
}

function listingHtml(listing: PublicListingSummary): string {
  const specs = specLine(listing);
  return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #ece7dd;">
        <div style="font:600 16px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
          ${escapeHtml(priceLabel(listing))}
        </div>
        <div style="font:400 15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;margin-top:2px;">
          ${escapeHtml(listing.address)}, ${escapeHtml(listing.suburb)} ${escapeHtml(listing.state)}
        </div>
        ${
          specs
            ? `<div style="font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5c5c5c;margin-top:4px;">${escapeHtml(specs)}</div>`
            : ''
        }
      </td>
    </tr>`;
}

function listingText(listing: PublicListingSummary): string {
  const specs = specLine(listing);
  return [
    `  ${priceLabel(listing)}`,
    `  ${listing.address}, ${listing.suburb} ${listing.state}`,
    specs ? `  ${specs}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the digest.
 *
 * ## Every number here comes from SQL
 *
 * The subject line, the heading and each listing's price are rendered from
 * `matched`, `newCount` and `priceLabel()` — the same formatter the chat
 * tools use. The model's contribution is one paragraph of prose in one
 * `<p>`, and it is validated upstream to contain no figures at all. #4 holds
 * because there is no path by which a model-produced number could reach this
 * template, not because the prompt asks nicely.
 *
 * ## It throws rather than sending something non-compliant
 *
 * No sender name, no postal address, or no unsubscribe URL and this refuses
 * to build a message. The Spam Act requires a commercial electronic message
 * to identify its sender, give a way to contact them, and carry a working
 * unsubscribe. An email missing any of those is not a worse email — it is
 * one that must not be sent, so the failure belongs here and not in a
 * reviewer's memory.
 */
export function buildScheduleDigestEmail(input: ScheduleDigestInput): EmailMessage {
  if (!input.from.name.trim() || !input.postalAddress.trim()) {
    throw new EmailError(
      'Refusing to build an alert email with no sender identity — see ALERT_SENDER_NAME / ALERT_SENDER_ADDRESS',
    );
  }
  if (!input.unsubscribeUrl.trim()) {
    throw new EmailError('Refusing to build an alert email with no unsubscribe link');
  }

  const shown = input.listings.slice(0, EMAIL_LISTING_LIMIT);
  const body = input.summary?.trim()
    ? input.summary.trim()
    : templateSummary(input);

  const headline =
    input.newCount > 0
      ? `${input.newCount} new ${input.newCount === 1 ? 'home' : 'homes'} for ${escapeHtml(input.scheduleName)}`
      : `Nothing new for ${escapeHtml(input.scheduleName)}`;

  const subject =
    input.newCount > 0
      ? `${input.newCount} new ${input.newCount === 1 ? 'listing' : 'listings'} — ${input.scheduleName}`
      : `No new listings — ${input.scheduleName}`;

  /**
   * Labelled, and the label is not decoration.
   *
   * #7 says AI-written copy is never published unreviewed. A listing
   * advertisement in an agency's name is the case that rule exists for, and
   * this is not that — it is a first-person note from the platform to its own
   * account holder. It is still model output reaching a person with nobody in
   * between, so it says so.
   */
  const attribution =
    input.summarySource === 'model'
      ? `<div style="font:400 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#8c8577;margin-top:6px;">Written by the property guide</div>`
      : '';

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f7f4ef;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ef;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d9d2c5;border-radius:12px;padding:28px;">
        <tr><td>
          <h1 style="font:600 20px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;margin:0;">
            ${headline}
          </h1>
          <div style="font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5c5c5c;margin-top:4px;">
            ${escapeHtml(input.description)}
          </div>

          <p style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;margin:20px 0 0;">
            ${escapeHtml(body)}
          </p>
          ${attribution}

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
            ${shown.map(listingHtml).join('')}
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;">
            <tr><td style="background:#0b3d2e;border-radius:6px;">
              <a href="${escapeHtml(input.resultsUrl)}"
                 style="display:inline-block;padding:12px 22px;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f7f4ef;text-decoration:none;">
                View all ${input.matched} results
              </a>
            </td></tr>
          </table>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;padding:20px 8px 0;">
        <tr><td style="font:400 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#8c8577;">
          You are receiving this because you saved a search called
          &ldquo;${escapeHtml(input.scheduleName)}&rdquo;.<br>
          <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#5c5c5c;">Unsubscribe from this alert</a><br><br>
          ${escapeHtml(input.from.name)}, ${escapeHtml(input.postalAddress)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    headline.replace(/&[a-z]+;/g, ''),
    input.description,
    '',
    body,
    input.summarySource === 'model' ? '(Written by the property guide)' : null,
    '',
    ...shown.map(listingText),
    '',
    `View all ${input.matched} results: ${input.resultsUrl}`,
    '',
    '---',
    `You are receiving this because you saved a search called "${input.scheduleName}".`,
    `Unsubscribe: ${input.unsubscribeUrl}`,
    `${input.from.name}, ${input.postalAddress}`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    to: input.to,
    from: input.from,
    subject,
    html,
    text,
    listUnsubscribeUrl: input.unsubscribeUrl,
  };
}
