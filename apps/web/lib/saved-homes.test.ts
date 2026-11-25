import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The saved-homes store (ADR 0100), driven without React: the Server Actions and the one read are fakes.
 * Each case is a guard that went red when its line in saved-homes.ts was broken on purpose.
 */

const setSaved = vi.fn();
const restoreSaved = vi.fn();
vi.mock('./shortlist-action', () => ({
  setSaved: (...a: unknown[]) => setSaved(...a),
  restoreSaved: (...a: unknown[]) => restoreSaved(...a),
}));

const storage = new Map<string, string>();
Object.assign(globalThis, {
  window: {
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    location: { pathname: '/search', search: '?suburb=Pakenham' },
  },
});

type Answer = { signedIn: boolean; ids: string[] };
let answer: Answer = { signedIn: true, ids: [] };
const reply = (body: Answer) => ({ ok: true, json: async () => body });
const fetchMock = vi.fn(async () => reply(answer));
Object.assign(globalThis, { fetch: fetchMock });

/** A read that answers only when told to. */
function heldRead(body: Answer) {
  let release = () => {};
  fetchMock.mockImplementationOnce(() => new Promise((r) => (release = () => r(reply(body)))));
  return () => release();
}

const m = await import('./saved-homes');
const tick = () => new Promise((r) => setTimeout(r, 0));
const ids = () => m.savedHomesSnapshot().ids;

async function mount(hearts = 1) {
  const offs = Array.from({ length: hearts }, () => m.subscribeSavedHomes(() => {}));
  await tick();
  await tick();
  return () => offs.forEach((off) => off());
}

beforeEach(() => {
  setSaved.mockReset();
  restoreSaved.mockReset();
  fetchMock.mockClear();
  storage.clear();
  answer = { signedIn: true, ids: ['a'] };
});

describe('saved homes (ADR 0100)', () => {
  it('one read for twenty hearts; forgotten when the last goes; read again on the next page', async () => {
    const off = await mount(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(m.savedHomesSnapshot()).toMatchObject({ loaded: true, signedIn: true });
    expect(ids().has('a')).toBe(true);
    off();
    expect(m.savedHomesSnapshot().loaded).toBe(false);
    const again = await mount();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    again();
  });

  it('a save shows at once, a second press in flight is ignored, and a failure puts it back', async () => {
    const off = await mount();
    let finish: (v: unknown) => void = () => {};
    setSaved.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const first = m.toggleSaved('b');
    expect(ids().has('b')).toBe(true);
    expect(m.savedHomesSnapshot().busy.has('b')).toBe(true);
    await m.toggleSaved('b');
    expect(setSaved).toHaveBeenCalledTimes(1);
    finish({ ok: false, error: 'Nope' });
    await first;
    expect(ids().has('b')).toBe(false);
    expect(m.savedHomesSnapshot().busy.has('b')).toBe(false);
    off();
  });

  it('Undo hands back what the removal returned, and the home is saved again', async () => {
    const off = await mount();
    const removed = { note: 'Big yard', savedAt: '2026-11-01T00:00:00.000Z' };
    setSaved.mockResolvedValueOnce({ ok: true, removed });
    restoreSaved.mockResolvedValueOnce({ ok: true });
    await m.toggleSaved('a');
    expect(ids().has('a')).toBe(false);
    expect(await m.undoRemove('a', removed)).toBe(true);
    expect(restoreSaved).toHaveBeenCalledWith('a', removed);
    expect(ids().has('a')).toBe(true);
    off();
  });

  it('an answer for a page that is gone never lands on the next one', async () => {
    const release = heldRead({ signedIn: true, ids: ['old'] });
    const off = m.subscribeSavedHomes(() => {});
    await tick();
    off();
    const next = await mount();
    release();
    await tick();
    await tick();
    expect(ids().has('old')).toBe(false);
    next();
  });

  it('signed out: the press goes to sign-in and is remembered; back signed in, it is saved', async () => {
    answer = { signedIn: false, ids: [] };
    const off = await mount();
    expect(await m.pressHeart('x')).toBe(`/login?next=${encodeURIComponent('/search?suburb=Pakenham')}`);
    off();
    answer = { signedIn: true, ids: [] };
    setSaved.mockResolvedValue({ ok: true, removed: null });
    const back = await mount();
    await tick();
    expect(setSaved).toHaveBeenCalledWith('x', true);
    expect(storage.size).toBe(0);
    back();
  });

  it('a remembered press older than ten minutes is dropped', async () => {
    storage.set('saved-homes:intent', `y|${Date.now() - 11 * 60_000}`);
    const off = await mount();
    await tick();
    expect(setSaved).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
    off();
  });

  it('a press before the read answers waits for it', async () => {
    const release = heldRead({ signedIn: true, ids: [] });
    setSaved.mockResolvedValue({ ok: true, removed: null });
    const off = m.subscribeSavedHomes(() => {});
    const pressed = m.pressHeart('z');
    await tick();
    expect(setSaved).not.toHaveBeenCalled();
    release();
    await pressed;
    expect(setSaved).toHaveBeenCalledWith('z', true);
    off();
  });
});
