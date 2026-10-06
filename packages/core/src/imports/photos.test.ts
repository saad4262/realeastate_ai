import { describe, expect, it } from 'vitest';
import { assertPublicUrl, fetchPublicImage, isPrivateAddress, pinnedFetch } from './photos';

/**
 * Photo links come from a FILE someone uploaded; the server fetches them. It
 * must never be pointed at our own network (ADR 0029 §8).
 */
const resolveTo = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

describe('photo links never reach a private network', () => {
  it('knows the private, loopback, link-local and carrier ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '203.0.113.9', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses non-web schemes, credentials, private hosts and names that resolve privately', async () => {
    const r = resolveTo({ 'photos.example': ['93.184.216.34'], 'sneaky.example': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '127.0.0.1'] });
    await expect(assertPublicUrl('https://photos.example/a.jpg', r)).resolves.toBeInstanceOf(URL);
    for (const bad of ['file:///etc/passwd', 'ftp://photos.example/a.jpg', 'http://169.254.169.254/latest/meta-data', 'http://localhost/a.jpg', 'https://sneaky.example/a.jpg', 'https://mixed.example/a.jpg', 'https://user:pw@photos.example/a.jpg', 'http://[::1]/a.jpg']) {
      await expect(assertPublicUrl(bad, r), bad).rejects.toThrow();
    }
  });

  it('a redirect to a private address is refused, re-checked on every hop', async () => {
    const r = resolveTo({ 'photos.example': ['93.184.216.34'] });
    const fake = (async (url: URL) => {
      if (url.pathname === '/a.jpg') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
      return new Response('x', { headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;
    await expect(fetchPublicImage('https://photos.example/a.jpg', fake, r)).rejects.toThrow(/public internet/);
  });

  it('a name that turns private between the check and the connection (DNS rebinding) is refused at connect', async () => {
    let calls = 0;
    // First answer (the check): public. Every later answer (the socket's own lookup): loopback.
    const rebinding = async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    const viaSocket = ((url: URL, init: { signal?: AbortSignal }) => pinnedFetch(url, init, rebinding)) as never;
    await expect(fetchPublicImage('http://rebind.example/a.jpg', viaSocket, rebinding)).rejects.toThrow(/public internet/);
    expect(calls).toBe(2);
  });

  it('only JPEG, PNG or WebP images, at most 10 MB', async () => {
    const r = resolveTo({ 'photos.example': ['93.184.216.34'] });
    const html = (async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(fetchPublicImage('https://photos.example/a', html, r)).rejects.toThrow(/JPEG, PNG or WebP/);
    const huge = (async () => new Response('x', { headers: { 'content-type': 'image/jpeg', 'content-length': String(11 * 1024 * 1024) } })) as unknown as typeof fetch;
    await expect(fetchPublicImage('https://photos.example/a', huge, r)).rejects.toThrow(/10 MB/);
    const ok = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    await expect(fetchPublicImage('https://photos.example/a', ok, r)).resolves.toMatchObject({ contentType: 'image/png' });
  });
});
