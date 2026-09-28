import { WebShell } from '../../../components/web-shell';
import { ListingSkeleton } from '../../../components/skeletons';
import { portalFonts } from '../../portal-fonts';

/**
 * The one navigation on this site that had no feedback at all.
 *
 * A card click is a cold round trip — listing cards do not prefetch, because
 * 48 of them on a results page would be 48 requests — so the browser sat on
 * the search results with nothing happening until the server answered. On a
 * database a region away that is a couple of hundred milliseconds of the click
 * appearing to have done nothing.
 *
 * Deliberately NOT a root app/loading.tsx. That would replace the shell on
 * every top-level navigation, which is the full-page blank this codebase has
 * already fought once.
 */
export default function ListingLoading() {
  return (
    <WebShell wide>
      {/* The skin and the mock's families, same as the page. Without them the
          page arrives and changes both colour and typeface, which reads as a
          second load rather than as the first one finishing. */}
      <div data-skin="portal" className={`${portalFonts} min-h-screen bg-canvas`}>
        <ListingSkeleton />
      </div>
    </WebShell>
  );
}
