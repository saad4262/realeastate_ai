import { WebShell } from '../../../../components/web-shell';
import { Bar } from '../../../../components/skeletons';

/** § 10 — the suburb page with its text removed: title, line, the two figure cards and the side card. */
export default function SuburbLoading() {
  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6" aria-busy="true" aria-label="Loading the suburb">
        <Bar w="16rem" h="2.25rem" />
        <div className="mt-2">
          <Bar w="50%" h="1rem" />
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]" aria-hidden>
          <div>
            {[12, 10].map((h, i) => (
              <div key={i} className="mb-4 rounded-2xl border border-line bg-card p-5" style={{ height: `${h}rem` }}>
                <Bar w="30%" h="0.75rem" />
              </div>
            ))}
          </div>
          <div className="h-32 rounded-2xl border border-line bg-card p-5">
            <Bar w="40%" h="0.75rem" />
          </div>
        </div>
      </main>
    </WebShell>
  );
}
