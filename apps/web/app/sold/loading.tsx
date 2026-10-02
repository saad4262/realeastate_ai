import { WebShell } from '../../components/web-shell';
import { ResultListSkeleton } from '../../components/skeletons';
import { portalFonts } from '../portal-fonts';

/** The same skeleton /search uses — this page reads the database twice. */
export default function SoldLoading() {
  return (
    <WebShell wide>
      <div data-skin="portal" className={`${portalFonts} min-h-screen bg-canvas`}>
        <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl">
          <ResultListSkeleton />
        </div>
      </div>
    </WebShell>
  );
}
