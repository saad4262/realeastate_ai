import { escapeHtml } from './schedule-digest';

/**
 * The "what is this about" block every agency email about a lead carries:
 * kind, the offer, the property and its features, the ad, the last sale, the
 * person and what they wrote. One builder so the new-lead notice, the offer
 * notice and the reply notice cannot describe a lead three different ways.
 *
 * Structural only — no imports from leads/, so email/ stays free of db code.
 * Every figure is formatted from a value read out of a column (#4).
 */
export type LeadDetails = {
  kind: 'enquiry' | 'inspection' | 'appraisal' | 'offer';
  status?: string | null;
  createdAt: Date;
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
  offerAmount: number | null;
  address: string;
  property: {
    type: string | null;
    bedrooms: number | null;
    bathrooms: number | null;
    carSpaces: number | null;
    landAreaSqm: number | null;
  };
  listing: { headline: string | null; priceDisplay: string | null; status: string; channel: string } | null;
  lastSale: { price: number; date: Date | null } | null;
  /** The public page for the property or its ad. */
  propertyUrl?: string | null;
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const DATE = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
const WHEN = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Australia/Sydney',
});

const KIND: Record<LeadDetails['kind'], string> = {
  enquiry: 'Enquiry',
  inspection: 'Inspection request',
  appraisal: 'Appraisal request',
  offer: 'Private offer',
};

const STATUS: Record<string, string> = {
  live: 'For sale now',
  under_offer: 'Under offer',
  sold: 'Sold',
  withdrawn: 'Withdrawn',
  pending: 'Awaiting approval',
  draft: 'Draft',
};

/** "3 bed · 2 bath · 1 car · House · 650 m²" — only the facts we have. */
export function featureLine(p: LeadDetails['property']): string | null {
  const parts = [
    p.bedrooms !== null ? `${p.bedrooms} bed` : null,
    p.bathrooms !== null ? `${p.bathrooms} bath` : null,
    p.carSpaces !== null ? `${p.carSpaces} car` : null,
    p.type ? p.type.charAt(0).toUpperCase() + p.type.slice(1) : null,
    p.landAreaSqm !== null ? `${Math.round(p.landAreaSqm)} m²` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The rows, in reading order: [label, value]. Shared by both parts. */
export function leadDetailRows(d: LeadDetails): [string, string][] {
  const rows: [string, string][] = [['Type', KIND[d.kind]]];
  if (d.kind === 'offer' && d.offerAmount !== null) rows.push(['Offer', AUD.format(d.offerAmount)]);
  rows.push(['Property', d.address]);
  const features = featureLine(d.property);
  if (features) rows.push(['Features', features]);
  if (d.listing) {
    const ad = [
      d.listing.headline,
      d.listing.priceDisplay,
      STATUS[d.listing.status] ?? d.listing.status,
    ].filter(Boolean);
    if (ad.length) rows.push(['Listing', ad.join(' · ')]);
  } else if (d.kind === 'offer') {
    rows.push(['Listing', 'Not on the market — the offer is for the owner']);
  }
  if (d.lastSale) {
    rows.push([
      'Last sold',
      `${AUD.format(d.lastSale.price)}${d.lastSale.date ? ` on ${DATE.format(d.lastSale.date)}` : ''}`,
    ]);
  }
  rows.push(['From', [d.name, d.email, d.phone].filter(Boolean).join(' · ')]);
  rows.push(['Received', WHEN.format(d.createdAt)]);
  return rows;
}

export function leadDetailsHtml(d: LeadDetails): string {
  const rows = leadDetailRows(d)
    .map(([label, value]) => {
      const shown =
        label === 'Property' && d.propertyUrl
          ? `<a href="${escapeHtml(d.propertyUrl)}" style="color:#0b3d2e;">${escapeHtml(value)}</a>`
          : label === 'Offer'
            ? `<strong style="font-size:18px;color:#0b3d2e;">${escapeHtml(value)}</strong>`
            : escapeHtml(value);
      return `<tr>
        <td style="padding:6px 12px 6px 0;font:600 13px/1.5 ${FONT};color:#5c5c5c;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:6px 0;font:400 14px/1.5 ${FONT};color:#1a1a1a;">${shown}</td>
      </tr>`;
    })
    .join('');
  const said = d.message?.trim()
    ? `<div style="margin-top:14px;padding:12px 14px;border-left:3px solid #0b3d2e;background:#f7f4ef;font:400 15px/1.6 ${FONT};color:#1a1a1a;white-space:pre-wrap;">${escapeHtml(d.message.trim())}</div>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid #ece7dd;padding-top:10px;">${rows}</table>${said}`;
}

export function leadDetailsText(d: LeadDetails): string[] {
  const lines = leadDetailRows(d).map(([label, value]) => `${label}: ${value}`);
  if (d.propertyUrl) lines.push(`Page: ${d.propertyUrl}`);
  if (d.message?.trim()) lines.push('', 'Their message:', d.message.trim());
  return lines;
}
