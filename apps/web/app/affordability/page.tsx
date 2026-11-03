import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AU_DUTY_STATES,
  estimateAffordability,
  readAffordability,
  SERVICEABILITY_BUFFER_PCT,
  type Affordability,
  type AffordabilityForm,
  type DutyEstimate,
} from '@repo/core/affordability';
import { consumerSkillBlocks, consumerSkillOffMessage } from '@repo/core/consumer-skills';
import { WebShell } from '../../components/web-shell';
import { getWebDb } from '../../lib/db';
import { currentWebUser } from '../../lib/session';

/** Every answer is in the address (decision 5), so every request renders. */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'What can I afford?',
  description: 'Repayments, stamp duty and what you could borrow, from your numbers and each state’s published rates.',
};

const STATE_NAMES: Record<(typeof AU_DUTY_STATES)[number], string> = {
  NSW: 'New South Wales',
  VIC: 'Victoria',
  QLD: 'Queensland',
  WA: 'Western Australia',
  SA: 'South Australia',
  TAS: 'Tasmania',
  ACT: 'Australian Capital Territory',
  NT: 'Northern Territory',
};

const aud = (n: number, cents = false) =>
  n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

const DISCLAIMER =
  'General information only, not financial or credit advice. Speak to a lender or a licensed broker before you decide. Figures come from your inputs and each state’s published rates — the AI never calculates them.';

/**
 * Affordability AI (ADR 0080, C1; mock docs/mocks/consumer-affordability.html). A GET form: the inputs are the
 * address, the figures are computed by core on the server, and it works with JavaScript off. No database read
 * except the buyer's Skills switch when signed in; income and expenses are never stored (decision 5).
 */
export default async function AffordabilityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])));
  const user = await currentWebUser();
  const block = (await consumerSkillBlocks(getWebDb(), user ? { userId: user.id } : null)).get('affordability');

  const read = readAffordability(params);
  const started = [...params.keys()].length > 0;
  const result = read.ok && !block ? estimateAffordability(read.input) : null;

  return (
    <WebShell account={{ signedIn: Boolean(user) }}>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">What can I afford?</h1>
        <p className="mt-1 max-w-[70ch] text-ink-soft">Repayments, stamp duty and what you could borrow — worked out from your numbers and each state’s published rates.</p>

        {block ? (
          <p role="status" className="mt-6 rounded-xl border border-line bg-card px-4 py-3 text-sm text-ink">
            {consumerSkillOffMessage('affordability', block)}{' '}
            {block === 'switched_off' ? (
              <Link href="/account/skills" className="font-semibold underline">
                Open Skills
              </Link>
            ) : null}
          </p>
        ) : (
          <div className="mt-6 grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
            <Inputs form={read.form} />
            <div>
              {result && read.ok ? (
                <Results a={result} state={read.input.state} budgetGiven={Boolean(read.input.budget)} />
              ) : started && !read.ok ? (
                <Card title="Almost there">
                  <p className="text-sm text-ink-soft">{read.error ?? `Add ${read.missing.length > 1 ? `${read.missing.slice(0, -1).join(', ')} and ${read.missing.at(-1)}` : read.missing[0]} to see the figures.`}</p>
                </Card>
              ) : (
                <Card title="Your figures">
                  <p className="text-sm text-ink-soft">Fill in the home and the loan, then press “Work it out”. Add your budget to see what you could borrow.</p>
                </Card>
              )}
              <p className="mt-2 border-t border-line pt-3 text-xs leading-relaxed text-ink-soft">{DISCLAIMER}</p>
            </div>
          </div>
        )}
      </main>
    </WebShell>
  );
}

function Card({ title, tag, children }: { title: string; tag?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-2xl border border-line bg-card p-5">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-ink-soft">
        {title} {tag ? <span className="ml-1 rounded-full bg-info-soft px-2 py-0.5 text-[11px] text-info">{tag}</span> : null}
      </h2>
      {children}
    </section>
  );
}

const field = 'mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink';
const labelCls = 'mt-3 block text-sm font-semibold text-ink';

function Inputs({ form }: { form: AffordabilityForm }) {
  return (
    <form method="get" action="/affordability" className="h-fit rounded-2xl border border-line bg-card p-5">
      <h2 className="text-xs font-bold uppercase tracking-wider text-ink-soft">The home</h2>
      <label className={labelCls}>
        Price
        <input name="price" defaultValue={form.price} inputMode="numeric" placeholder="e.g. 750,000" className={field} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          State
          <select name="state" defaultValue={form.state} className={field}>
            <option value="">Choose…</option>
            {AU_DUTY_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_NAMES[s]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Type
          <select name="kind" defaultValue={form.kind} className={field}>
            <option value="established">Established home</option>
            <option value="new">New home</option>
            <option value="vacant_land">Vacant land</option>
          </select>
        </label>
      </div>
      <label className={labelCls}>
        Who is buying
        <select name="buyer" defaultValue={form.buyer} className={field}>
          <option value="first">My first home — I will live in it</option>
          <option value="home">A home I will live in</option>
          <option value="investor">An investment</option>
        </select>
      </label>

      <h2 className="mt-5 text-xs font-bold uppercase tracking-wider text-ink-soft">The loan</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Deposit
          <input name="deposit" defaultValue={form.deposit} inputMode="numeric" placeholder="e.g. 150,000" className={field} />
        </label>
        <label className={labelCls}>
          Interest rate <span className="font-normal text-ink-faint">% p.a.</span>
          <input name="rate" defaultValue={form.rate} inputMode="decimal" placeholder="your lender’s rate" className={field} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Term
          <select name="term" defaultValue={form.term} className={field}>
            {[30, 25, 20, 15, 10].map((y) => (
              <option key={y} value={y}>
                {y} years
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Repayments
          <select name="repay" defaultValue={form.repay} className={field}>
            <option value="pi">Principal &amp; interest</option>
            <option value="io">Interest only</option>
          </select>
        </label>
      </div>
      <label className={labelCls}>
        Other costs <span className="font-normal text-ink-faint">conveyancing, inspections — your figure</span>
        <input name="costs" defaultValue={form.costs} inputMode="numeric" placeholder="optional" className={field} />
      </label>

      <h2 className="mt-5 text-xs font-bold uppercase tracking-wider text-ink-soft">
        Your budget <span className="normal-case tracking-normal text-ink-faint">— optional, never saved</span>
      </h2>
      <div className="grid grid-cols-2 gap-3">
        <label className={labelCls}>
          Take-home pay <span className="font-normal text-ink-faint">/ month</span>
          <input name="pay" defaultValue={form.pay} inputMode="numeric" className={field} />
        </label>
        <label className={labelCls}>
          Living costs <span className="font-normal text-ink-faint">/ month</span>
          <input name="living" defaultValue={form.living} inputMode="numeric" className={field} />
        </label>
      </div>
      <label className={labelCls}>
        Other repayments <span className="font-normal text-ink-faint">car, cards, HECS / month</span>
        <input name="debts" defaultValue={form.debts} inputMode="numeric" placeholder="optional" className={field} />
      </label>
      <button type="submit" className="mt-5 w-full rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-brand-ink">
        Work it out
      </button>
    </form>
  );
}

function Results({ a, state, budgetGiven }: { a: Affordability; state: (typeof AU_DUTY_STATES)[number]; budgetGiven: boolean }) {
  return (
    <>
      <Card title="Each month" tag="Estimate">
        <p className="font-display text-4xl font-bold tracking-tight text-ink">{aud(a.monthly)}</p>
        <p className="mt-1 text-sm text-ink-soft">
          On a loan of {aud(a.loan)}. Total interest over the loan, principal and interest: {aud(a.totalInterest)}.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {a.rises.map((r) => (
            <div key={r.ratePct} className="rounded-xl bg-sunken px-4 py-3">
              <p className="text-xl font-bold tabular-nums text-ink">{aud(r.monthly)}</p>
              <p className="text-xs text-ink-soft">If the rate rises to {r.ratePct}%</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Cash you need upfront" tag="Estimate">
        <table className="w-full text-sm">
          <tbody>
            <Row label="Deposit" value={aud(a.upfront.deposit)} />
            <DutyRow duty={a.duty} />
            {a.upfront.otherCosts ? <Row label="Other costs — your figure" value={aud(a.upfront.otherCosts)} /> : null}
            <tr className="border-t border-line font-bold">
              <td className="py-2">Total</td>
              <td className="py-2 text-right tabular-nums">{a.upfront.total === null ? '—' : aud(a.upfront.total)}</td>
            </tr>
          </tbody>
        </table>
        {a.lmiMayApply ? <p className="mt-2 text-sm text-ink-soft">With a deposit under 20%, lenders mortgage insurance may apply. It is not included.</p> : null}
        <Sources duty={a.duty} />
      </Card>

      {a.borrowing ? (
        <Card title="What you could borrow" tag="Estimate">
          <p className="font-display text-4xl font-bold tracking-tight text-ink">about {aud(a.borrowing.capacity)}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {aud(a.borrowing.surplusMonthly)} a month left after your living costs and other repayments, tested at {a.borrowing.assessmentRatePct}% (your rate + the {SERVICEABILITY_BUFFER_PCT}% buffer lenders use).
          </p>
          {!a.borrowing.covers ? (
            <p className="mt-3 rounded-lg border-l-4 border-notice bg-notice-soft px-3 py-2 text-sm text-ink">
              This loan ({aud(a.loan)}) is more than the estimate. A lender may lend less.
            </p>
          ) : null}
          {a.borrowing.maxPrice > 0 ? (
            <p className="mt-3 text-sm text-ink">
              With your deposit, that reaches homes up to about <b>{aud(a.borrowing.maxPrice)}</b>
              {a.borrowing.maxPriceIncludesDuty ? ', after stamp duty and your other costs.' : ' before stamp duty, which we have not verified for this state.'}
            </p>
          ) : null}
          {a.borrowing.maxPrice > 0 ? (
            <p className="mt-4">
              <Link href={`/search?channel=sale&state=${state}&priceTo=${a.borrowing.maxPrice}`} className="inline-block rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink">
                Homes for sale in {state} up to {aud(a.borrowing.maxPrice)}
              </Link>
            </p>
          ) : null}
        </Card>
      ) : budgetGiven ? null : (
        <Card title="What you could borrow">
          <p className="text-sm text-ink-soft">Add your take-home pay and living costs to see an estimate.</p>
        </Card>
      )}
    </>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: string }) {
  return (
    <tr className="border-t border-line-subtle first:border-t-0">
      <td className="py-2 align-top">{label}</td>
      <td className="py-2 pl-3 text-right align-top tabular-nums">{value}</td>
    </tr>
  );
}

function DutyRow({ duty }: { duty: DutyEstimate }) {
  if (duty.status === 'unverified') {
    return (
      <Row
        label={
          <>
            Stamp duty
            <span className="mt-1 block text-xs text-ink-soft">
              We have not yet verified {duty.what}, so we do not show a figure.{' '}
              <a href={duty.sources[0]!.url} target="_blank" rel="noopener noreferrer" className="underline">
                Check the official site
              </a>
              .
            </span>
          </>
        }
        value="—"
      />
    );
  }
  const saving = duty.generalDuty !== null ? duty.generalDuty - duty.duty : 0;
  return (
    <Row
      label={
        <>
          Stamp duty{' '}
          {duty.applied !== 'general' ? <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-bold text-success">{duty.applied === 'first_home' ? 'First home' : 'Home you live in'}</span> : null}{' '}
          {!duty.exact ? <span className="rounded-full bg-notice-soft px-2 py-0.5 text-[11px] font-bold text-notice">Approximate</span> : null}
          {saving > 0 ? <span className="mt-1 block text-xs text-ink-soft">At the general rate it would be {aud(duty.generalDuty!, true)} — you save {aud(saving, true)}.</span> : null}
          {duty.notes.map((n) => (
            <span key={n} className="mt-1 block text-xs text-ink-soft">
              {n}
            </span>
          ))}
        </>
      }
      value={aud(duty.duty, !Number.isInteger(duty.duty))}
    />
  );
}

function Sources({ duty }: { duty: DutyEstimate }) {
  return (
    <p className="mt-3 text-xs text-ink-faint">
      {duty.sources.map((s, i) => (
        <span key={s.url}>
          {i ? ' · ' : ''}
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">
            {s.name}
          </a>
        </span>
      ))}{' '}
      — checked {new Date(`${duty.sources[0]!.checkedOn}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}. Excludes the foreign buyer surcharge.
    </p>
  );
}
