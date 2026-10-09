import type { WidgetFormat } from '@repo/core/widgets';

/** How each kind of figure is written. Formatting only — every number came from SQL. */
const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('en-AU');
const dec = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });

export function formatValue(format: WidgetFormat, n: number | null): string {
  if (n === null) return '—';
  switch (format) {
    case 'money':
      return aud.format(n);
    case 'days':
      return `${int.format(n)} day${n === 1 ? '' : 's'}`;
    case 'decimal':
      return dec.format(n);
    case 'count':
      return int.format(n);
  }
}

/** Short form for axes and tight spots: $1.2M, $850k, 1.2k. */
export function formatShort(format: WidgetFormat, n: number): string {
  const abs = Math.abs(n);
  const unit = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e4 ? [1e3, 'k'] : null;
  const body = unit ? `${dec.format(n / (unit[0] as number))}${unit[1]}` : format === 'decimal' ? dec.format(n) : int.format(Math.round(n));
  return format === 'money' ? `$${body}` : body;
}
