import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O-38 (2026-11-20): the sign-in pages carried a design mock's claims — "ISO 27001 Certified", "256-bit AES",
 * "NSW Property and Stock Agents Act 2002 Compliant", "Sydney Metro Datacenter: 14ms". A claim we cannot back is
 * misleading conduct under the Australian Consumer Law. A new one needs the owner's say-so and a line here.
 */
const repo = resolve(__dirname, '../../..');
// O-40 (2026-11-21) added the AI page's and the sign-in page's mock status: invented versions, throughput, latency, syncs.
const CLAIMS = /ISO\s*27001|SOC\s*2|256-bit|\bCertified\b|\bCompliant\b|Datacenter:\s*\d+\s*ms|Core Active|Autonomous v\d|data points\/sec|GPT-RealEstate|\d+\s*ms Mesh|LIVE REINSW|Pre-populates REINSW|Session edge/i;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.next')) return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(n) ? [p] : [];
  });

describe('no unbacked security or compliance claims on our pages (O-38)', () => {
  it('no page names a certification, a cipher, a compliance badge or a latency figure', () => {
    const hits = ['web', 'console'].flatMap((app) =>
      files(join(repo, 'apps', app)).flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((l, i) => (CLAIMS.test(l) && !/O-38/.test(l) ? `${relative(repo, f)}:${i + 1}: ${l.trim().slice(0, 80)}` : null))
          .filter((x): x is string => x !== null),
      ),
    );
    expect(hits).toEqual([]);
  });
});
