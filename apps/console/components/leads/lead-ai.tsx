'use client';

import { useState, useTransition } from 'react';
import type { LeadAiView } from '@repo/core/leads';
import { proposeLeadBriefAction } from '@/lib/lead-ai-actions';
import { ProposalCardView } from '../assistant/assistant-panel';

/**
 * ADR 0078: what the AI understood of one lead, labelled as the AI's — type, urgency, a one-line summary, and
 * the facts it found, each beside the enquiry's own words; what it left out says so. "Save to … brief" makes a
 * card (it changes nothing until approved), shown right here.
 */

const INTENT: Record<string, { label: string; icon: string }> = {
  buyer: { label: 'Buyer', icon: 'home' },
  seller: { label: 'Seller', icon: 'sell' },
  landlord: { label: 'Landlord', icon: 'real_estate_agent' },
  tenant: { label: 'Tenant', icon: 'key' },
  investor: { label: 'Investor', icon: 'trending_up' },
  general: { label: 'General', icon: 'chat' },
  not_sure: { label: 'Not sure', icon: 'help' },
};
const FIELD: Record<string, string> = {
  price_from: 'Price from', price_to: 'Price to', bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', suburbs: 'Suburbs',
  property_type: 'Type', timeline: 'Timeline', own_address: 'Their home', own_when: 'Selling when',
};
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const show = (field: string, v: number | string | string[]) =>
  field === 'price_from' || field === 'price_to' ? AUD.format(Number(v)) : field === 'bedrooms' || field === 'bathrooms' ? `${v}+` : Array.isArray(v) ? v.join(', ') : String(v);

const chip: React.CSSProperties = { display: 'inline-flex', gap: '0.25rem', alignItems: 'center', fontSize: '0.75rem', fontWeight: 600, padding: '0.0625rem 0.5rem', borderRadius: '0.375rem', background: '#f5f3ff', color: '#6d28d9' };
const urgent: React.CSSProperties = { ...chip, borderRadius: '999px', background: '#fff1f2', color: '#e11d48' };
const small: React.CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)' };

export function LeadAiChips({ ai }: { ai: LeadAiView | null }) {
  if (!ai) return null;
  const i = INTENT[ai.intent] ?? INTENT.not_sure!;
  return (
    <span style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={chip}><span className="material-symbols-outlined" aria-hidden style={{ fontSize: '0.875rem' }}>{i.icon}</span>{i.label}</span>
      {ai.urgency === 'high' ? <span style={urgent}>Urgent</span> : null}
      <span style={{ ...small, color: '#6d28d9', fontWeight: 600 }}>AI</span>
    </span>
  );
}

export function LeadAiBlock({ leadId, ai, mayPropose, surface }: { leadId: string; ai: LeadAiView | null; status: string | null; mayPropose: boolean; surface: 'agency' | 'agent' }) {
  const [cardId, setCardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!ai) return null;
  const briefFields = ai.facts.filter((f) => ['price_from', 'price_to', 'bedrooms', 'bathrooms', 'suburbs', 'property_type'].includes(f.field));
  return (
    <div style={{ marginTop: '0.375rem', display: 'grid', gap: '0.25rem' }}>
      <LeadAiChips ai={ai} />
      {ai.summary ? <div style={{ fontSize: '0.8125rem' }}>{ai.summary}</div> : null}
      <details>
        <summary style={{ ...small, cursor: 'pointer' }}>What the AI found — written by the AI, each figure from the enquiry’s words</summary>
        <div style={{ display: 'grid', gap: '0.25rem', marginTop: '0.375rem', fontSize: '0.8125rem' }}>
          {ai.intentWhy ? <div><span style={small}>Why {INTENT[ai.intent]?.label.toLowerCase() ?? 'this'}: </span>{ai.intentWhy}</div> : null}
          {ai.urgencyWhy ? <div><span style={small}>Urgency: </span>{ai.urgencyWhy}</div> : null}
          {ai.facts.map((f, n) => (
            <div key={`f${n}`}>
              <span style={small}>{FIELD[f.field] ?? f.field}: </span><b>{show(f.field, f.value)}</b>{' '}
              <q style={{ ...small, color: '#6d28d9' }}>{f.quote}</q>
            </div>
          ))}
          {ai.dropped.map((d, n) => (
            <div key={`d${n}`} style={{ ...small, textDecoration: 'line-through' }}>{FIELD[d.field] ?? d.field}: {d.value} — not in the enquiry, left out</div>
          ))}
          {mayPropose && briefFields.length && !cardId ? (
            <div>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const r = await proposeLeadBriefAction(leadId);
                    if ('cardId' in r) setCardId(r.cardId);
                    else setError(r.error);
                  })
                }
                style={{ padding: '0.25rem 0.625rem', borderRadius: '0.375rem', border: '1px solid var(--border-default, #e2e8f0)', background: 'transparent', cursor: 'pointer', fontSize: '0.8125rem' }}
              >
                {pending ? 'Preparing…' : 'Save to their brief…'}
              </button>
            </div>
          ) : null}
          {error ? <div role="alert" style={{ color: '#e11d48', fontSize: '0.8125rem' }}>{error}</div> : null}
          {cardId ? <ProposalCardView id={cardId} surface={surface} /> : null}
        </div>
      </details>
    </div>
  );
}
