import Link from 'next/link';
import { AU_DUTY_STATES, affordabilityPath, estimateStampDuty, type DutyState } from '@repo/core/affordability';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { Card } from './listing-sections';
import { HideIfSkillOff } from './hide-if-skill-off';

const aud = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

const BUYERS = [
  { label: 'First home, you live in it', firstHome: true, ownerOccupier: true, buyer: 'first' },
  { label: 'A home you live in', firstHome: false, ownerOccupier: true, buyer: 'home' },
  { label: 'An investment', firstHome: false, ownerOccupier: false, buyer: 'investor' },
] as const;

/**
 * "Costs to buy this home" (ADR 0080, C1 decision 6b): stamp duty at the listing's numeric price for three
 * kinds of buyer, computed in core from the state's published rates. Nothing at all without a numeric price
 * (#6: the display string is never parsed) or for a rental. The top of a range, so the estimate is never low.
 *
 * No repayments here: they need an interest rate, and any rate this page chose would be a number with no
 * source. The link carries the price and the state to the calculator, where the buyer types their own.
 *
 * This page is cached and has no session (ARCHITECTURE § 9), so a buyer's own switch is honoured in the
 * browser by HideIfSkillOff; the platform pause is honoured here, at render.
 */
export function CostsToBuy({ channel, state, priceFrom, priceTo }: { channel: string; state: string; priceFrom: number | null; priceTo: number | null }) {
  const price = priceTo ?? priceFrom;
  if (channel !== 'sale' || !price || !(AU_DUTY_STATES as readonly string[]).includes(state)) return null;
  if (pausedConsumerSkills().has('affordability')) return null;
  const s = state as DutyState;
  const rows = BUYERS.map((b) => ({ ...b, duty: estimateStampDuty({ state: s, value: Math.round(price), ownerOccupier: b.ownerOccupier, firstHome: b.firstHome, propertyKind: 'established' }) }));
  const source = rows[0]!.duty.sources[0]!;

  return (
    <HideIfSkillOff skill="affordability">
      <Card eyebrow="Affordability AI · Estimate" title="Costs to buy this home" note={`Stamp duty at ${aud(price)}${priceFrom && priceTo ? ', the top of the advertised range' : ''}, for an established home.`}>
        <table className="w-full text-body-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.buyer} className="border-t border-line-subtle first:border-t-0">
                <td className="py-2 align-top text-ink">
                  {r.label}
                  {r.duty.status === 'estimate' && !r.duty.exact ? <span className="ml-2 rounded-full bg-notice-soft px-2 py-0.5 text-[11px] font-bold text-notice">Approximate</span> : null}
                </td>
                <td className="py-2 pl-3 text-right align-top tabular-nums text-ink">{r.duty.status === 'estimate' ? aud(r.duty.duty) : 'Not verified'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-sm text-label-sm text-ink-soft">
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline">
            {source.name}
          </a>
          , checked {source.checkedOn}. General information only, not financial or credit advice.
        </p>
        <p className="mt-md">
          <Link href={affordabilityPath({ price: Math.round(price), state: s })} className="inline-block rounded-full border border-line px-4 py-2 text-body-sm font-semibold text-ink hover:border-ink">
            Work out repayments and what you could borrow
          </Link>
        </p>
      </Card>
    </HideIfSkillOff>
  );
}
