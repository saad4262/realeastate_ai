/**
 * Error monitoring in the browser, without its weight on first load (ADR 0082). The SDK added 37 kB to every public page when imported
 * at the top, so it loads when the page goes idle, or at once when an error comes first, and never when there is no DSN. The first
 * error is handed over by hand because the SDK's own handlers did not exist yet when it was thrown.
 */

type Sdk = { init: (options: never) => unknown; captureException: (error: unknown) => unknown };

export function browserMonitoring(load: () => Promise<Sdk>, options: { enabled: boolean }) {
  let sdk: Promise<Sdk> | null = null;
  const ready = () => {
    sdk ??= load().then((s) => {
      s.init(options as never);
      return s;
    });
    return sdk;
  };
  const report = (error: unknown) => {
    if (options.enabled) void ready().then((s) => s.captureException(error)).catch(() => undefined);
  };
  return {
    report,
    /** Call once, as the page starts. */
    start(target: EventTarget = globalThis as unknown as EventTarget, whenIdle: (run: () => void) => void = onIdle) {
      if (!options.enabled) return;
      const first = (event: Event) => {
        stop();
        report((event as ErrorEvent).error ?? (event as PromiseRejectionEvent).reason ?? event);
      };
      const stop = () => {
        target.removeEventListener('error', first);
        target.removeEventListener('unhandledrejection', first);
      };
      target.addEventListener('error', first);
      target.addEventListener('unhandledrejection', first);
      whenIdle(() => {
        stop();
        void ready().catch(() => undefined);
      });
    },
  };
}

function onIdle(run: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => unknown }).requestIdleCallback;
  if (idle) idle(run, { timeout: 5000 });
  else setTimeout(run, 3000);
}
