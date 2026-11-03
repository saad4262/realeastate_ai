import { WebShell } from '../../components/web-shell';
import { Bar } from '../../components/skeletons';

/** § 10 — the plan with its text removed: title, the line under it, the plan card and the settings card. */
export default function InspectionsLoading() {
  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6" aria-busy="true" aria-label="Loading your plan">
        <Bar w="18rem" h="2.25rem" />
        <div className="mt-2">
          <Bar w="50%" h="1rem" />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="h-96 rounded-2xl border border-line bg-card p-5" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="mt-5 first:mt-0">
                <Bar w="100%" h="2.5rem" />
              </div>
            ))}
          </div>
          <div className="h-48 rounded-2xl border border-line bg-card p-5" aria-hidden />
        </div>
      </main>
    </WebShell>
  );
}
