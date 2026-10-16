import type { CSSProperties, ReactNode } from 'react';

/**
 * Sign out, as a form that POSTs to /sign-out — never a link, which Next would
 * prefetch (see app/(shared)/sign-out/route.ts). No client JavaScript: it works
 * with it off. `next` is where to land afterwards (relative; /login by default).
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
    <form method="post" action="/sign-out" style={{ display: 'inline', margin: 0 }}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <button
        type="submit"
        title={title}
        aria-label={title}
        className={className}
        style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', ...style }}
      >
        {children}
      </button>
    </form>
  );
}
