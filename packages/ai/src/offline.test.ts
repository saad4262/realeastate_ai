import { describe, expect, it } from 'vitest';

/**
 * The guard that keeps this suite free.
 *
 * `pnpm test` must cost nothing. Every AI test hands the pipeline a fake
 * client, which made that true by convention — and a convention is a thing the
 * next test forgets. The failure mode is silent: a live call succeeds, the
 * suite stays green, and the only evidence is a credit balance going down.
 *
 * This asserts the setup file is actually loaded, so removing it from
 * vitest.config.ts fails here rather than on a bill.
 */
describe('unit tests cannot reach the network', () => {
  it('refuses a request to the Anthropic API', async () => {
    await expect(async () =>
      fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }),
    ).rejects.toThrow(/offline/i);
  });

  it('names the URL it blocked, so the culprit is obvious', async () => {
    await expect(async () => fetch('https://example.test/anything')).rejects.toThrow(
      /example\.test/,
    );
  });

  it('leaves non-network URLs alone', () => {
    // data: and blob: are not the network and are not what this guards.
    expect(() => fetch('data:text/plain,hello')).not.toThrow(/offline/i);
  });
});
