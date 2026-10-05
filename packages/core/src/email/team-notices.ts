import { leadDetailsHtml, leadDetailsText, type LeadDetails } from './lead-details';
import { escapeHtml, requireSenderFooter } from './schedule-digest';
import { type TransactionalMessage } from './transport';

/**
 * Mail to the people who work at an agency, about their own work: "you have
 * been invited", "a lead came in for you".
 *
 * Transactional for the same reason the private-offer notice is — it tells a
 * person something that just happened to them, it advertises nothing — so no
 * unsubscribe header (see `TransactionalMessage`). Sender identity and the
 * postal address are still required in both parts, through the same
 * `requireSenderFooter`.
 *
 * Nothing here is model-written: every line is a template filled from rows.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

type Footer = { from: { email: string; name: string }; postalAddress: string; why: string };

/** One card, one button, the footer. Every value is escaped by the caller's escapeHtml. */
function layout(opts: {
  heading: string;
  intro: string;
  /** Already-escaped HTML for the middle of the card. */
  body: string;
  button: { label: string; url: string };
  after?: string;
  footer: Footer;
}): string {
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f7f4ef;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ef;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d9d2c5;border-radius:12px;padding:28px;">
        <tr><td>
          <h1 style="font:600 20px/1.3 ${FONT};color:#1a1a1a;margin:0;">${escapeHtml(opts.heading)}</h1>
          <div style="font:400 14px/1.5 ${FONT};color:#5c5c5c;margin-top:6px;">${escapeHtml(opts.intro)}</div>
          ${opts.body}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;">
            <tr><td style="background:#0b3d2e;border-radius:6px;">
              <a href="${escapeHtml(opts.button.url)}"
                 style="display:inline-block;padding:12px 22px;font:600 15px/1 ${FONT};color:#f7f4ef;text-decoration:none;">
                ${escapeHtml(opts.button.label)}
              </a>
            </td></tr>
          </table>
          ${
            opts.after
              ? `<div style="font:400 13px/1.5 ${FONT};color:#5c5c5c;margin-top:14px;">${escapeHtml(opts.after)}</div>`
              : ''
          }
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;padding:20px 8px 0;">
        <tr><td style="font:400 12px/1.6 ${FONT};color:#8c8577;">
          ${escapeHtml(opts.footer.why)}<br><br>
          ${escapeHtml(opts.footer.from.name)}, ${escapeHtml(opts.footer.postalAddress)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function textFooter(footer: Footer): string[] {
  return ['---', footer.why, `${footer.from.name}, ${footer.postalAddress}`];
}

// ── Agent invite ────────────────────────────────────────────────────────────

export type AgentInviteEmailInput = {
  to: { email: string; name?: string };
  from: { email: string; name: string };
  postalAddress: string;
  agencyName: string;
  /** Who sent it, when known — "Sara Khan invited you". */
  invitedBy: string | null;
  /** The full claim URL on the agent host, token included. */
  claimUrl: string;
  /** "2 hours" — from formatRemaining, so the email and the console agree. */
  validFor: string;
};

/**
 * "You have been invited to join <agency>." Carries the claim link itself,
 * which is a bearer secret for setting up the account — so it goes only to the
 * address the invite was made for, and the email says how long it lasts.
 */
export function buildAgentInviteEmail(input: AgentInviteEmailInput): TransactionalMessage {
  requireSenderFooter(input.from, input.postalAddress, 'agent invite');

  const who = input.invitedBy ? `${input.invitedBy} has invited you` : 'You have been invited';
  const heading = `Join ${input.agencyName}`;
  const intro = `${who} to join ${input.agencyName} as an agent.`;
  const after = `This link works for ${input.validFor} and only once. If it has run out, ask ${input.agencyName} to send a new one.`;
  const footer: Footer = {
    from: input.from,
    postalAddress: input.postalAddress,
    why: `Sent because ${input.agencyName} invited this address to their team. If you were not expecting it, you can ignore this email.`,
  };

  const html = layout({
    heading,
    intro,
    body: `<p style="font:400 15px/1.6 ${FONT};color:#1a1a1a;margin:18px 0 0;">Set a password to open your agent desk, where you will see your listings and the leads sent to you.</p>`,
    button: { label: 'Accept the invite', url: input.claimUrl },
    after,
    footer,
  });

  const text = [
    heading,
    '',
    intro,
    'Set a password to open your agent desk, where you will see your listings and the leads sent to you.',
    '',
    `Accept the invite: ${input.claimUrl}`,
    '',
    after,
    '',
    ...textFooter(footer),
  ].join('\n');

  return {
    kind: 'transactional',
    to: input.to,
    from: input.from,
    subject: `${input.agencyName} invited you to join their team`,
    html,
    text,
    tags: { kind: 'agent-invite' },
  };
}

// ── Lead notice ─────────────────────────────────────────────────────────────

export type LeadNoticeEmailInput = {
  to: { email: string; name?: string };
  from: { email: string; name: string };
  postalAddress: string;
  /** `new`: arrived on a listing you are named on. `assigned`: somebody gave it to you. */
  reason: 'new' | 'assigned';
  kind: 'enquiry' | 'inspection' | 'appraisal' | 'offer';
  /** The address it is about, or null when the row has none to show. */
  propertyAddress: string | null;
  person: { name: string; email: string; phone: string | null };
  /** What they wrote, or null when the form had nothing to say. */
  message: string | null;
  /** Where the recipient works this lead — their own inbox, on their own host. */
  inboxUrl: string;
  /**
   * The lead's conversation address (ADR 0016). Replying to the notice then
   * answers the buyer through the platform, and the console shows it.
   */
  replyTo?: { email: string; name?: string };
  /**
   * The full picture — offer, property, features, ad, last sale, person,
   * message. When present it replaces the short message-and-contact block.
   */
  details?: LeadDetails;
};

const KIND_WORD: Record<LeadNoticeEmailInput['kind'], string> = {
  enquiry: 'enquiry',
  inspection: 'inspection request',
  appraisal: 'appraisal request',
  offer: 'private offer',
};

/**
 * "A lead is waiting for you."
 *
 * The contact details and the message are in the body because the point is a
 * fast reply — the recipient may answer straight from their phone. Only people
 * who may already read the lead in the console are ever sent one; who that is
 * is decided in leads/lead-notices.ts, through can().
 *
 * With `details`, the whole lead is in it — including an offer's amount. That
 * is safe because of who receives it: lead-notices.ts sends an offer's notice
 * only to people `lead:read_offer` allows, the same people the console shows
 * the amount to. The client asked for the detail so an agent can act from the
 * email alone.
 */
export function buildLeadNoticeEmail(input: LeadNoticeEmailInput): TransactionalMessage {
  requireSenderFooter(input.from, input.postalAddress, 'lead notice');

  const what = KIND_WORD[input.kind];
  const where = input.propertyAddress ? ` about ${input.propertyAddress}` : '';
  const heading =
    input.reason === 'new'
      ? `New ${what}${where}`
      : `${/^[aeiou]/.test(what) ? 'An' : 'A'} ${what} was assigned to you`;
  const intro =
    input.reason === 'new'
      ? 'It came in through a listing you are named on.'
      : `${input.person.name} is now yours to follow up${where}.`;
  const footer: Footer = {
    from: input.from,
    postalAddress: input.postalAddress,
    why:
      input.reason === 'new'
        ? 'Sent because a lead arrived on a listing you are an agent on.'
        : 'Sent because this lead was assigned to you.',
  };

  const p = input.person;
  const phoneLine = p.phone
    ? `<br>Phone: <a href="tel:${escapeHtml(p.phone)}" style="color:#0b3d2e;">${escapeHtml(p.phone)}</a>`
    : '';

  const html = layout({
    heading,
    intro,
    body: input.details
      ? leadDetailsHtml(input.details)
      : `${
      input.message
        ? `
          <p style="font:400 15px/1.6 ${FONT};color:#1a1a1a;margin:18px 0 0;white-space:pre-wrap;">${escapeHtml(input.message)}</p>`
        : ''
    }
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
            <tr><td style="padding:16px 0 0;border-top:1px solid #ece7dd;font:400 15px/1.6 ${FONT};color:#1a1a1a;">
              <strong style="font-weight:600;">${escapeHtml(p.name)}</strong><br>
              <a href="mailto:${escapeHtml(p.email)}" style="color:#0b3d2e;">${escapeHtml(p.email)}</a>${phoneLine}
            </td></tr>
          </table>`,
    button: { label: 'Open in your leads', url: input.inboxUrl },
    footer,
  });

  const text = [
    heading,
    intro,
    '',
    ...(input.details
      ? leadDetailsText(input.details)
      : [...(input.message ? [input.message, ''] : []), 'From:', p.name, p.email, p.phone]),
    '',
    `Open in your leads: ${input.inboxUrl}`,
    '',
    ...textFooter(footer),
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    kind: 'transactional',
    to: input.to,
    from: input.from,
    subject: heading,
    html,
    text,
    tags: { kind: input.reason === 'new' ? 'lead-new' : 'lead-assigned' },
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };
}

// ── Contact assigned ────────────────────────────────────────────────────────

export type ContactAssignedEmailInput = {
  to: { email: string; name?: string };
  from: { email: string; name: string };
  postalAddress: string;
  contact: {
    name: string;
    email: string | null;
    phone: string | null;
    /** Role words, already labelled — "Buyer", "Seller". */
    roles: string[];
    nextAction: string | null;
  };
  /** Who handed it over, for the intro line. */
  assignedByName: string | null;
  /** The contact's profile, on the recipient's own host. */
  profileUrl: string;
};

/**
 * "A contact was assigned to you" (ADR 0018) — the lead notice's twin.
 *
 * Only who they are and how to reach them, never their enquiries or emails:
 * those still answer to `lead:read` / `mail:read`, and the profile shows each
 * one only to whoever may open it. contacts/contact-notices.ts decides who
 * receives this, through can().
 */
export function buildContactAssignedEmail(input: ContactAssignedEmailInput): TransactionalMessage {
  requireSenderFooter(input.from, input.postalAddress, 'contact notice');
  const c = input.contact;
  const heading = `${c.name} is now your contact`;
  const intro = input.assignedByName
    ? `${input.assignedByName} assigned them to you.`
    : 'They were assigned to you.';
  const footer: Footer = {
    from: input.from,
    postalAddress: input.postalAddress,
    why: 'Sent because a contact was assigned to you.',
  };

  const lines = [
    c.email ? `<a href="mailto:${escapeHtml(c.email)}" style="color:#0b3d2e;">${escapeHtml(c.email)}</a>` : null,
    c.phone ? `Phone: <a href="tel:${escapeHtml(c.phone)}" style="color:#0b3d2e;">${escapeHtml(c.phone)}</a>` : null,
    c.roles.length ? `Roles: ${escapeHtml(c.roles.join(', '))}` : null,
    c.nextAction ? `Next action: ${escapeHtml(c.nextAction)}` : null,
  ].filter(Boolean);

  const html = layout({
    heading,
    intro,
    body: `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
            <tr><td style="padding:16px 0 0;border-top:1px solid #ece7dd;font:400 15px/1.6 ${FONT};color:#1a1a1a;">
              <strong style="font-weight:600;">${escapeHtml(c.name)}</strong>${lines.length ? `<br>${lines.join('<br>')}` : ''}
            </td></tr>
          </table>`,
    button: { label: 'Open their profile', url: input.profileUrl },
    footer,
  });

  const text = [
    heading,
    intro,
    '',
    c.name,
    c.email,
    c.phone ? `Phone: ${c.phone}` : null,
    c.roles.length ? `Roles: ${c.roles.join(', ')}` : null,
    c.nextAction ? `Next action: ${c.nextAction}` : null,
    '',
    `Open their profile: ${input.profileUrl}`,
    '',
    ...textFooter(footer),
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    kind: 'transactional',
    to: input.to,
    from: input.from,
    subject: heading,
    html,
    text,
    tags: { kind: 'contact-assigned' },
  };
}

// ── Skill result (to the agent themselves) ─────────────────────────────────

export type SkillResultEmailInput = {
  to: { email: string; name?: string };
  from: { email: string; name: string };
  postalAddress: string;
  skillName: string;
  /** "Monday 6 October", in the agent's zone. */
  today: string;
  summary: string | null;
  /** True when the summary is the assistant's — then it carries a visible label (#7). */
  summaryByAssistant: boolean;
  /** Lines rendered from SQL: times, names, subjects. */
  lines: string[];
  resultUrl: string;
};

/**
 * A skill's result, to the agent who ran it (docs/adr/0021). Transactional:
 * it tells a person what they asked for; it advertises nothing. The
 * assistant's text is labelled; every list line is from SQL; citation
 * markers like [A1] are stripped here — the page has the links.
 */
export function buildSkillResultEmail(input: SkillResultEmailInput): TransactionalMessage {
  requireSenderFooter(input.from, input.postalAddress, 'skill result');
  const heading = `${input.skillName} — ${input.today}`;
  const summary = input.summary?.replace(/\s*\[[A-Z]\d{1,3}\]/g, '').trim() ?? null;
  const footer: Footer = {
    from: input.from,
    postalAddress: input.postalAddress,
    why: 'Sent because you asked for this skill’s result by email. Turn it off on the skill’s page.',
  };
  const label = input.summaryByAssistant ? 'Written by the AI assistant from your records' : 'Summary';
  const html = layout({
    heading,
    intro: label,
    body: `${summary ? `<p style="font:400 15px/1.6 ${FONT};color:#1a1a1a;margin:12px 0 0;">${escapeHtml(summary)}</p>` : ''}
          ${input.lines.length ? `<ul style="font:400 14px/1.6 ${FONT};color:#1a1a1a;padding-left:18px;margin:14px 0 0;">${input.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}`,
    button: { label: 'Open the full result', url: input.resultUrl },
    footer,
  });
  const text = [heading, '', `${label}:`, summary ?? '', '', ...input.lines.map((l) => `- ${l}`), '', `Open the full result: ${input.resultUrl}`, '', ...textFooter(footer)]
    .join('\n');
  return { kind: 'transactional', to: input.to, from: input.from, subject: heading, html, text, tags: { kind: 'skill-result' } };
}
