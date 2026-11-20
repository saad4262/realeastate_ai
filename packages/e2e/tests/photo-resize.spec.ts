// PLATFORM-PLAN 5.8: a listing photo is resized in the browser and loses its EXIF (GPS) before it is stored.
import { expect, test } from '@playwright/test';
import { env, sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

/** An APP1 "Exif" segment (a minimal TIFF header) carrying a GPS marker, put straight after the JPEG's SOI. */
function withExif(jpeg: Buffer): Buffer {
  const tiff = Buffer.concat([Buffer.from('MM\x00\x2a\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from('GPSLatitude -33.8688 GPSLongitude 151.2093', 'latin1')]);
  const body = Buffer.concat([Buffer.from('Exif\x00\x00', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, jpeg.subarray(2)]);
}

test('a 4000 × 3000 phone photo with GPS goes up 2560 wide, with no EXIF in the stored file', async ({ page }) => {
  const w = world();
  await signIn(page, urls.agent, w.a.agent.email);
  await page.goto(`${urls.agent}/listings/${w.a.draftListingId}/edit?tab=photos`);

  const raw = await page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 4000, height: 3000 });
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#3a7';
    ctx.fillRect(0, 0, 4000, 3000);
    ctx.fillStyle = '#fff';
    ctx.fillRect(400, 300, 1200, 900);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const photo = withExif(Buffer.from(raw));
  expect(photo.includes(Buffer.from('Exif'))).toBe(true);

  await page.locator('input[type="file"][multiple]').first().setInputFiles({ name: 'phone.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.getByText(/^1 of 20\./)).toBeVisible({ timeout: 120_000 });

  const sql = sqlClient();
  const { url, key } = env();
  const bucket = process.env.NEXT_PUBLIC_SUPABASE_MEDIA_BUCKET || 'media';
  let storageKey: string | null = null;
  try {
    const [m] = await sql`select storage_key, width, height from media where listing_id = ${w.a.draftListingId} order by created_at desc limit 1`;
    storageKey = m!.storage_key as string;
    expect([m!.width, m!.height]).toEqual([2560, 1920]);
    const stored = Buffer.from(await (await fetch(`${url}/storage/v1/object/public/${bucket}/${storageKey}`)).arrayBuffer());
    expect(stored.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(stored.includes(Buffer.from('Exif'))).toBe(false);
    expect(stored.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(stored.length).toBeLessThan(photo.length);
  } finally {
    if (storageKey) {
      await fetch(`${url}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [storageKey] }) });
    }
    await sql.end();
  }
});
