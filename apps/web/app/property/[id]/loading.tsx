import { WebShell } from '../../../components/web-shell';
import { ListingSkeleton } from '../../../components/skeletons';
import { portalFonts } from '../../portal-fonts';

/**
 * The same skeleton the listing page uses.
 *
 * This route reads the database twice before it can draw anything, and without
 * this the click sits on the previous page doing nothing. Carries the skin and
 * the families for the same reason listing/loading.tsx does: without them the
 * page arrives and changes colour and typeface, which reads as a second load
 * rather than the first one finishing.
 */
export default function PropertyLoading() {
  return (
    <WebShell wide>
      <div data-skin="portal" className={`${portalFonts} min-h-screen bg-canvas`}>
        <ListingSkeleton />
      </div>
    </WebShell>
  );
}
