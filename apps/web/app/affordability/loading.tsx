import { WebShell } from '../../components/web-shell';
import { Bar } from '../../components/skeletons';

/**
 * § 10 — the Affordability page with its text removed: the title, the form card on the left and the figure
 * cards on the right, at their real widths. It reads the buyer's Skills switch when signed in.
 */
export default function AffordabilityLoading() {
  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6" aria-busy="true" aria-label="Loading the calculator">
        <Bar w="16rem" h="2.25rem" />
        <div className="mt-2">
          <Bar w="60%" h="1rem" />
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]" aria-hidden>
          <div className="h-[34rem] overflow-hidden rounded-2xl border border-line bg-card p-5">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="mt-4 first:mt-0">
                <Bar w="40%" h="0.875rem" />
                <div className="mt-2">
                  <Bar w="100%" h="2.25rem" />
                </div>
              </div>
            ))}
          </div>
          <div>
            {[8, 10, 8].map((h, i) => (
              <div key={i} className="mb-4 rounded-2xl border border-line bg-card p-5" style={{ height: `${h}rem` }}>
                <Bar w="30%" h="0.75rem" />
                <div className="mt-3">
                  <Bar w="45%" h="2.25rem" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </WebShell>
  );
}
