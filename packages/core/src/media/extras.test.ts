import { describe, expect, it } from 'vitest';
import { embedUrl, floorplanRoomsSchema, floorplanToolResult, linkKey, parseMediaLink, readLinkKey, roomNames } from './extras';

describe('Immersive: links on a fixed allowlist, stored as provider:id (ADR 0080, C9 decision 2)', () => {
  it('reads the usual shapes of YouTube, Vimeo and Matterport links', () => {
    expect(parseMediaLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toEqual({ kind: 'video', provider: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMediaLink('https://youtu.be/dQw4w9WgXcQ')).toEqual({ kind: 'video', provider: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMediaLink('https://www.youtube.com/shorts/dQw4w9WgXcQ')?.id).toBe('dQw4w9WgXcQ');
    expect(parseMediaLink('https://vimeo.com/123456789')).toEqual({ kind: 'video', provider: 'vimeo', id: '123456789' });
    expect(parseMediaLink('https://player.vimeo.com/video/123456789?h=abc')?.id).toBe('123456789');
    expect(parseMediaLink('https://my.matterport.com/show/?m=SxQL3iGyoDo')).toEqual({ kind: 'tour', provider: 'matterport', id: 'SxQL3iGyoDo' });
  });

  it('refuses anything else: http, another host, a look-alike, credentials, a bad id, script', () => {
    for (const bad of [
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
      'https://evil.test/https://youtu.be/dQw4w9WgXcQ',
      'https://user:pw@youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/short',
      'https://www.youtube.com/watch?v=<script>',
      'https://vimeo.com/channels/staffpicks',
      'https://my.matterport.com/models/SxQL3iGyoDo',
      'javascript:alert(1)',
      'not a link',
    ]) expect(parseMediaLink(bad), bad).toBeNull();
  });

  it('the stored form is never a URL, and comes back only as itself', () => {
    const l = parseMediaLink('https://youtu.be/dQw4w9WgXcQ')!;
    expect(linkKey(l)).toBe('youtube:dQw4w9WgXcQ');
    expect(linkKey(l)).not.toMatch(/:\/\/|^\//);
    expect(readLinkKey('youtube:dQw4w9WgXcQ')).toEqual(l);
    expect(readLinkKey('vimeo:not-digits')).toBeNull();
    expect(readLinkKey('evil:anything')).toBeNull();
    expect(readLinkKey('youtube:dQw4w9WgXcQ"><script>')).toBeNull();
  });

  it('the embed address is built by code, the privacy-enhanced player where there is one', () => {
    expect(embedUrl({ kind: 'video', provider: 'youtube', id: 'dQw4w9WgXcQ' })).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0');
    expect(embedUrl({ kind: 'video', provider: 'vimeo', id: '123456789' })).toBe('https://player.vimeo.com/video/123456789?dnt=1');
    expect(embedUrl({ kind: 'tour', provider: 'matterport', id: 'SxQL3iGyoDo' })).toBe('https://my.matterport.com/show/?m=SxQL3iGyoDo&play=1');
  });
});

describe('Immersive: the floorplan’s rooms by name, never a size (decision 3)', () => {
  it('accepts room names only; a size, an area or a count refuses the answer', () => {
    expect(floorplanRoomsSchema.safeParse({ rooms: ['kitchen', 'bedroom', 'bedroom', 'study'] }).success).toBe(true);
    expect(floorplanRoomsSchema.safeParse({ rooms: ['kitchen'], sizes: { kitchen: '4.2 x 3.6' } }).success).toBe(false);
    expect(floorplanRoomsSchema.safeParse({ rooms: ['kitchen 4.2 x 3.6'] }).success).toBe(false);
    expect(floorplanRoomsSchema.safeParse({ rooms: ['bedroom'], bedrooms: 3 }).success).toBe(false);
    expect(floorplanRoomsSchema.safeParse({ rooms: ['ballroom'] }).success).toBe(false);
  });
  it('each name once, in a fixed order, without "other"', () => {
    expect(roomNames({ rooms: ['study', 'bedroom', 'kitchen', 'bedroom', 'other'] })).toEqual(['kitchen', 'bedroom', 'study']);
  });
  it('the guide’s result names rooms and forbids sizes', () => {
    const out = floorplanToolResult('l1', { floorplans: [{ id: 'f', url: 'https://cdn.test/f.png', width: null, height: null, rooms: ['kitchen', 'bedroom', 'deck'] }], videos: [], tours: [] });
    expect(out).toMatchObject({ found: true, rooms: ['Kitchen', 'Bedrooms', 'Deck'], floorplans: 1, page: '/listing/l1#floorplan' });
    expect(out.rules).toMatch(/Never give a size, a dimension or an area/);
    expect(floorplanToolResult('l1', { floorplans: [], videos: [], tours: [] }).found).toBe(false);
  });
});
