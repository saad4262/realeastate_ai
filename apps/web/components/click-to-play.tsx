'use client';

import { useState } from 'react';

/**
 * A video or 3D tour that loads only when the buyer presses play (ADR 0080, C9 decision 2): until then nothing is
 * fetched from YouTube, Vimeo or Matterport and no third-party cookie is set. `src` was built by core from an allowlisted
 * provider and id — never a URL from the agent.
 */
export function ClickToPlay({ src, title, label, provider }: { src: string; title: string; label: string; provider: string }) {
  const [on, setOn] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-line-subtle bg-sunken">
      <div className="relative aspect-video w-full">
        {on ? (
          <iframe src={src} title={title} className="absolute inset-0 h-full w-full" allow="autoplay; fullscreen; picture-in-picture; xr-spatial-tracking" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" loading="lazy" />
        ) : (
          <button type="button" onClick={() => setOn(true)} className="absolute inset-0 grid place-items-center text-ink">
            <span className="rounded-full bg-white/90 px-4 py-2 text-body-md font-semibold shadow-card">{label}</span>
          </button>
        )}
      </div>
      <p className="m-0 px-3 py-2 text-label-sm text-ink-soft">{on ? title : `${title} · loads from ${provider} when you press play`}</p>
    </div>
  );
}
