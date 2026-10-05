/**
 * Runs once when a console server starts (Next.js instrumentation hook).
 *
 * The check itself is Node-only (it reads the token key with node:crypto), so
 * it lives in ./instrumentation-node and is imported only inside the Node
 * branch — the documented pattern that keeps it out of the edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
