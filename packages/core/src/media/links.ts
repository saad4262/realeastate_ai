/**
 * Immersive's link rules (ADR 0080, C9 decision 2), pure and dependency-free so the import's column check — which also
 * runs in the browser's mapping screen — can use them. A video or tour is a link on a fixed allowlist, stored as
 * `provider:id`, never a URL; the embed address is rebuilt from that by code.
 */

export const MAX_FLOORPLANS = 4;
export const MAX_VIDEOS = 3;
export const MAX_TOURS = 2;

export const LINK_PROVIDERS = ['youtube', 'vimeo', 'matterport'] as const;
export type LinkProvider = (typeof LINK_PROVIDERS)[number];
const KIND_OF: Record<LinkProvider, 'video' | 'tour'> = { youtube: 'video', vimeo: 'video', matterport: 'tour' };
export const PROVIDER_NAME: Record<LinkProvider, string> = { youtube: 'YouTube', vimeo: 'Vimeo', matterport: 'Matterport' };

export type MediaLink = { kind: 'video' | 'tour'; provider: LinkProvider; id: string };

/**
 * A link an agent pasted, as `{ provider, id }` — or null for anything not on the allowlist. Only the exact hosts below,
 * https only, and an id of the provider's own shape: what comes back can be rebuilt into an embed address by code. Pure.
 */
export function parseMediaLink(raw: string): MediaLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.split('/').filter(Boolean);
  const yt = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? ({ kind: 'video', provider: 'youtube', id } as const) : null);
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (path[0] === 'watch') return yt(u.searchParams.get('v'));
    if (path[0] === 'embed' || path[0] === 'shorts' || path[0] === 'live') return yt(path[1]);
    return null;
  }
  if (host === 'youtu.be') return yt(path[0]);
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = host === 'player.vimeo.com' ? (path[0] === 'video' ? path[1] : undefined) : path.find((p) => /^\d+$/.test(p));
    return id && /^\d{5,12}$/.test(id) ? { kind: 'video', provider: 'vimeo', id } : null;
  }
  if (host === 'my.matterport.com' && path[0] === 'show') {
    const id = u.searchParams.get('m');
    return id && /^[A-Za-z0-9]{8,16}$/.test(id) ? { kind: 'tour', provider: 'matterport', id } : null;
  }
  return null;
}

/** The stored form: never a URL (the smoke invariant on `storage_key`). Pure. */
export const linkKey = (l: MediaLink) => `${l.provider}:${l.id}`;

/** A stored `provider:id` back to a link, re-checked — a row someone edited by hand is shown as nothing. Pure. */
export function readLinkKey(key: string): MediaLink | null {
  const [provider, id] = key.split(':');
  if (!provider || !id || !(LINK_PROVIDERS as readonly string[]).includes(provider)) return null;
  const p = provider as LinkProvider;
  const url = p === 'youtube' ? `https://youtu.be/${id}` : p === 'vimeo' ? `https://vimeo.com/${id}` : `https://my.matterport.com/show/?m=${id}`;
  const back = parseMediaLink(url);
  return back && back.provider === p ? back : null;
}

/** The embed address, built by code from the provider and id — the privacy-enhanced player where there is one. Pure. */
export function embedUrl(l: MediaLink): string {
  switch (l.provider) {
    case 'youtube':
      return `https://www.youtube-nocookie.com/embed/${l.id}?rel=0`;
    case 'vimeo':
      return `https://player.vimeo.com/video/${l.id}?dnt=1`;
    case 'matterport':
      return `https://my.matterport.com/show/?m=${l.id}&play=1`;
  }
}

