import type { CSSProperties } from 'react';
import type { DashboardData } from '@repo/core/dashboards';

/**
 * A dashboard's colours (ADR 0047) as the custom properties its charts read (`--chart-1…6`). The
 * first colour is the accent. When fewer than six were given, the rest are the given ones mixed
 * toward slate, so a ring of six slices stays in the same family instead of borrowing the
 * console's blue. No theme: nothing is set and every chart falls back to the console's palette.
 */
export function themeStyle(theme: DashboardData['theme']): CSSProperties | undefined {
  if (!theme?.colors.length) return undefined;
  const given = theme.colors;
  const style: Record<string, string> = {};
  for (let i = 0; i < 6; i += 1) {
    const base = given[i % given.length]!;
    const round = Math.floor(i / given.length);
    style[`--chart-${i + 1}`] = round === 0 ? base : `color-mix(in srgb, ${base} ${round === 1 ? 60 : 40}%, #64748b)`;
  }
  return style as CSSProperties;
}
