import { WebShell } from '../../../components/web-shell';
import { Bar } from '../../../components/skeletons';

/** § 10 — Saved homes with its text removed: back link, title, line, then a grid of photo cards. */
export default function ShortlistLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className="mx-auto w-full max-w-5xl pb-xl pt-md" aria-busy="true" aria-label="Loading your saved homes">
        <Bar w="7rem" h="0.875rem" />
        <div className="mt-2">
          <Bar w="13rem" h="2.25rem" />
        </div>
        <div className="mt-2">
          <Bar w="10rem" h="1rem" />
        </div>
        <div className="mt-lg grid gap-md sm:grid-cols-2" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="overflow-hidden rounded-lg border border-line-subtle bg-card">
              <Bar w="100%" h="11rem" />
              <div className="grid gap-2 p-md">
                <Bar w="45%" h="1.5rem" />
                <Bar w="75%" h="1rem" />
                <Bar w="35%" h="0.875rem" />
              </div>
            </div>
          ))}
        </div>
      </main>
    </WebShell>
  );
}
