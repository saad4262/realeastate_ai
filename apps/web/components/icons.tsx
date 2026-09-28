/**
 * The icon set, inline.
 *
 * The mock draws these with Material Symbols. This site does not load it any
 * more: requested across its whole variable axis space it was 4.0 MB of
 * render-blocking CSS — the single largest performance win in this repo
 * (ARCHITECTURE.md § 11) — and every rule that used it wanted one weight.
 * Bringing it back for a dozen glyphs would undo a slice of that for a page
 * whose whole job is to load fast on a phone.
 *
 * So: one path each, inlined into HTML the page was already sending, no extra
 * request, and they inherit `currentColor` so the skin colours them.
 *
 * `aria-hidden` on every one of them, without exception. Each is drawn beside
 * a label that is already read aloud — "3 Bedrooms", "Saturday 24 October" —
 * and an icon that names itself as well turns every spec into a stutter.
 */

const PATHS = {
  bed: 'M3 18v-6h18v6M3 12V7m0 5h18M7 12V9h4v3',
  bath: 'M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3ZM7 12V6a2 2 0 0 1 4 0',
  car: 'M5 16h14M6 16v2M18 16v2M4 12l1.5-4h13L20 12v4H4v-4ZM7 14h1M16 14h1',
  land: 'M4 5h16v14H4V5Zm0 5h16M9 5v14',
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z',
  calendar: 'M4 6h16v14H4V6Zm0 4h16M8 3v4m8-4v4',
  verified: 'm9 12 2 2 4-4M12 3l2.4 1.8 3 .3.3 3L19.5 10.5 21 12l-1.5 1.5-.8 2.9-3 .3L12 21l-2.4-1.8-3-.3-.8-2.9L3 12l1.8-2.4.3-3 3-.3Z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z',
  pin: 'M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Zm0-8.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z',
  gallery: 'M3 5h18v14H3V5Zm0 10 5-5 4 4 3-3 6 6M8.5 9.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  doc: 'M6 3h7l5 5v13H6V3Zm7 0v5h5M9 13h6M9 17h6',
  history: 'M12 7v5l3 2M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
  // Three ticks, not six. At 20px the denser version rendered as a solid
  // dark block rather than as a ruler — a glyph is only worth the bytes if
  // it is legible at the size it is actually drawn.
  ruler: 'M3 9.5h18v5H3v-5Zm4.5 0v2.2m4.5-2.2v2.2m4.5-2.2v2.2',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
