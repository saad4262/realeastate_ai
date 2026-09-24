/**
 * Loads the Google Maps JavaScript API once per page.
 *
 * The script is a global: loading it twice throws, and React in development
 * mounts every component twice. The promise below is the whole point — every
 * caller awaits the same load, and a second map on the same page costs nothing.
 *
 * This is the **browser** key, which is a different key from the server one:
 * it is visible in the page source by design, and is restricted by HTTP
 * referrer instead. The server key must never be used here — a referrer
 * restriction cannot protect a key that is sent from a server, and an IP
 * restriction cannot protect one sent from a browser.
 */

declare global {
  interface Window {
    google?: typeof google;
    /** The callback name the script calls when it is ready. */
    __repoMapsReady?: () => void;
  }
}

export function mapsBrowserKey(): string | null {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY?.trim();
  return key ? key : null;
}

export type MapsLoadState = 'unconfigured' | 'loading' | 'ready' | 'failed';

let pending: Promise<typeof google.maps> | null = null;

/**
 * Resolves with the maps namespace, or rejects with a reason worth showing.
 *
 * Rejecting rather than returning null keeps the caller's error path in one
 * place: a missing key, a blocked script and a refused referrer all arrive the
 * same way and all produce a panel the user can act on.
 */
export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Maps can only load in a browser'));
  }

  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (pending) return pending;

  const key = mapsBrowserKey();
  if (!key) {
    return Promise.reject(
      new Error('NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY is not set'),
    );
  }

  pending = new Promise<typeof google.maps>((resolve, reject) => {
    const CALLBACK = '__repoMapsReady';

    // A script this file added on a previous navigation may still be in flight.
    const existing = document.querySelector<HTMLScriptElement>('script[data-repo-maps]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google!.maps));
      existing.addEventListener('error', () => reject(new Error('Google Maps failed to load')));
      return;
    }

    window[CALLBACK] = () => {
      delete window.__repoMapsReady;
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error('Google Maps loaded without a maps namespace'));
    };

    const script = document.createElement('script');
    const params = new URLSearchParams({
      key,
      callback: CALLBACK,
      // Australia only — it decides which spellings and regional biases the
      // geocoder and the map labels use.
      region: 'AU',
      language: 'en-AU',
      // Google's own recommendation: loads the library without blocking paint.
      loading: 'async',
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.dataset.repoMaps = 'true';
    script.addEventListener('error', () => {
      pending = null;
      reject(new Error('Google Maps failed to load — check the key and its referrer rules'));
    });
    document.head.appendChild(script);
  });

  return pending;
}
