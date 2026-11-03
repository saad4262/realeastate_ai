import { checklistFor, GENERAL_CHECKLIST, type RecordFact } from '@repo/core/due-diligence';
import { pausedConsumerSkills } from '@repo/core/consumer-skills/catalog';
import { Card } from './listing-sections';
import { ChecklistTicks } from './checklist-ticks';
import { HideIfSkillOff } from './hide-if-skill-off';
import { DueDiligenceAi } from './due-diligence-ai';

const DISCLAIMER = 'General information, not legal advice. A conveyancer or solicitor should review the contract and the seller’s documents before you sign.';

/**
 * "Before you buy" (ADR 0080, C2; mock docs/mocks/consumer-due-diligence.html): what our records show about
 * the address (SQL, with references), the state's checklist written by us from its official pages, and the
 * official maps, then the AI's summary and drafted questions on a button (DueDiligenceAi).
 *
 * On the cached listing and property pages, so the buyer's own switch is honoured in the browser
 * (HideIfSkillOff) and the platform pause here, at render — as "Costs to buy this home".
 */
export function BeforeYouBuy({ state, facts, scope, subject }: { state: string; facts: RecordFact[] | null; scope: string; subject: { listingId: string } | { propertyId: string } }) {
  if (pausedConsumerSkills().has('due_diligence')) return null;
  const checklist = checklistFor(state);
  const items = [...(checklist?.items ?? []), ...GENERAL_CHECKLIST];

  return (
    <HideIfSkillOff skill="due_diligence">
      <Card id="before-you-buy" eyebrow="Due-Diligence AI" title="Before you buy" note={DISCLAIMER}>
        <div className="grid gap-lg">
          <section>
            <h3 className="mb-sm text-label-sm font-bold uppercase tracking-wide text-ink-soft">What our records show</h3>
            {facts === null ? (
              <p className="text-body-sm text-ink-soft">Our records could not be loaded just now. Try again shortly.</p>
            ) : facts.length === 0 ? (
              <p className="text-body-sm text-ink-soft">Nothing in our records for this address yet.</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {facts.map((f) => (
                  <li key={f.ref} className="grid grid-cols-[2.25rem_7.5rem_1fr] gap-2 border-t border-line-subtle py-2 text-body-sm first:border-t-0 first:pt-0">
                    <span className="inline-grid h-5 place-items-center rounded-md bg-sunken text-[11px] font-bold text-ink-soft">{f.ref}</span>
                    <span className="text-ink-soft">{f.when}</span>
                    <span className="text-ink">{f.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-sm text-label-sm text-ink-faint">From listings on this site, by any agency. A sale or listing elsewhere is not here.</p>
            {facts?.length ? (
              <div className="mt-md">
                <DueDiligenceAi subject={subject} />
              </div>
            ) : null}
          </section>

          <section>
            <h3 className="mb-sm text-label-sm font-bold uppercase tracking-wide text-ink-soft">Your checklist{checklist?.items ? ` for ${state}` : ''}</h3>
            {checklist && !checklist.items ? (
              <p className="mb-sm rounded-lg border-l-4 border-info bg-info-soft px-3 py-2 text-body-sm text-ink">
                We have not yet verified {state}’s own rules for buyers, so this is the general list. Check the state government’s pages or ask a conveyancer.
              </p>
            ) : null}
            <ChecklistTicks scope={scope} items={items} />
            <p className="mt-sm text-label-sm text-ink-faint">
              {checklist?.source ? (
                <>
                  <a href={checklist.source.url} target="_blank" rel="noopener noreferrer" className="underline">
                    {checklist.source.name}
                  </a>
                  , checked {checklist.source.checkedOn}.{' '}
                </>
              ) : null}
              Ticks are remembered in this browser only.
            </p>
          </section>

          {checklist?.maps.length ? (
            <section>
              <h3 className="mb-sm text-label-sm font-bold uppercase tracking-wide text-ink-soft">Check the maps</h3>
              {checklist.maps.map((m) => (
                <a key={m.url} href={m.url} target="_blank" rel="noopener noreferrer" className="flex justify-between gap-3 border-t border-line-subtle py-2 text-body-sm text-ink first:border-t-0 first:pt-0 hover:underline">
                  <span>{m.label}</span>
                  <span className="text-ink-faint">Opens ↗</span>
                </a>
              ))}
              <p className="mt-sm text-label-sm text-ink-faint">Official sites. We show no zoning, flood or heritage overlay ourselves.</p>
            </section>
          ) : null}
        </div>
      </Card>
    </HideIfSkillOff>
  );
}
