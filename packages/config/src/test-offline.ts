/**
 * Make a test run physically unable to reach the network.
 *
 * `pnpm test` must cost nothing and work on a plane. That was true by
 * convention — every AI test hands the pipeline a fake client — but a
 * convention is a thing the next test forgets, and the failure mode is
 * silent: a live call succeeds, the suite stays green, and the only evidence
 * is a credit balance going down. That happened here through `pnpm smoke`,
 * which is why this exists before it can happen through `pnpm test`.
 *
 * So the rule is enforced rather than remembered. Anything that tries to make
 * an HTTP request during a unit test fails loudly, naming the URL, and the
 * message says what to do instead.
 *
 * Loaded through `setupFiles` in each package's vitest config.
 */
const OFFLINE = (url: string) =>
  new Error(
    `Unit tests are offline: something tried to reach ${url}.\n` +
      `Hand the code under test a fake instead — see fakeClient in ` +
      `packages/ai/src/pipelines/property-chat.test.ts. If a real request is ` +
      `genuinely the point, it belongs in packages/smoke behind an explicit ` +
      `opt-in, not here.`,
  );

export function blockNetwork(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = ((input: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string })?.url ?? String(input));

    // Anything that is not an outbound http(s) request is left alone —
    // data: URLs and the like are not network and not what this guards.
    if (/^https?:/i.test(url)) throw OFFLINE(url);
    return realFetch(input as RequestInfo);
  }) as typeof fetch;
}

blockNetwork();
