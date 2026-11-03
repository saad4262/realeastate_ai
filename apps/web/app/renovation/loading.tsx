import { WebShell } from '../../components/web-shell';
import { Bar } from '../../components/skeletons';

/** § 10 — the Renovation page with its text removed: title, the form card and the plan column. */
export default function RenovationLoading() {
  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6" aria-busy="true" aria-label="Loading the renovation planner">
        <Bar w="14rem" h="2.25rem" />
        <div className="mt-2">
          <Bar w="60%" h="1rem" />
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]" aria-hidden>
          <div className="h-[28rem] rounded-2xl border border-line bg-card p-5">
            <Bar w="40%" h="0.875rem" />
            <div className="mt-3">
              <Bar w="100%" h="8rem" />
            </div>
          </div>
          <div>
            {[9, 6].map((h, i) => (
              <div key={i} className="mb-4 rounded-2xl border border-line bg-card p-5" style={{ height: `${h}rem` }}>
                <Bar w="30%" h="0.75rem" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </WebShell>
  );
}
