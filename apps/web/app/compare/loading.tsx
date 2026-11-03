import { WebShell } from '../../components/web-shell';
import { Bar } from '../../components/skeletons';

/** § 10 — Compare with its text removed: title, the buyer line, the table card. */
export default function CompareLoading() {
  return (
    <WebShell>
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6" aria-busy="true" aria-label="Loading the comparison">
        <Bar w="14rem" h="2.25rem" />
        <div className="mt-2">
          <Bar w="40%" h="1rem" />
        </div>
        <div className="mt-4 h-72 rounded-2xl border border-line bg-card p-5" aria-hidden>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="mt-3 first:mt-0">
              <Bar w="100%" h="1rem" />
            </div>
          ))}
        </div>
      </main>
    </WebShell>
  );
}
