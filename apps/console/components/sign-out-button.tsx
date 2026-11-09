import type { CSSProperties, ReactNode } from 'react';

/**
 * Sign out, as a form that POSTs to /sign-out — never a link, which Next would
 * prefetch (see app/(shared)/sign-out/route.ts). No client JavaScript: it works
 * with it off. `next` is where to land afterwards (relative; /login by default).
 *
 * Without a className it looks like the text around it. With one, the class
 * decides: the reset's `font: inherit` used to beat `.glyph`'s icon font, so
 * the sidebar showed the word "logout" spilling over the name beside it.
 */
export function SignOutButton({
  children,
  next,
  className,
  style,
  title,
}: {
  children: ReactNode;
  next?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <form method="post" action="/sign-out" style={{ display: 'contents' }}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <button
        type="submit"
        title={title}
        aria-label={title}
        className={className}
        style={className ? style : { background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', ...style }}
      >
        {children}
      </button>
    </form>
  );
}
