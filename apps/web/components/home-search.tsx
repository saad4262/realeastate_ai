'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { DEFAULT_RADIUS_KM, type PlaceSuggestion, type ResolvedPlace } from '@repo/core/geo/schema';
import {
  asksForTravelTime,
  DISTANCE_STEPS_KM,
  formatLoc,
  placeOnly,
  MAX_UNDERSTAND_CHARS,
  plausiblePrice,
  parseSearchText,
  suggestionToPlace,
  type ParsedSearch,
  type PlaceRef,
  type UnderstoodSearch,
} from '@repo/core/listings/url';
import { MAX_SEARCH_PLACES, PROPERTY_TYPES } from '@repo/core/listings/schema';
import { Spinner } from './spinner';
import styles from './home-search.module.css';

/**
 * The home page search box (docs/mocks/home-search.html, ADR 0099).
 *
 * Six tabs, several suburbs as chips, a Distance control that applies to each,
 * Filters, recent searches and the AI toggle. It reads no session and asks the
 * server nothing until someone types, so `/` stays a cached route.
 *
 * It only BUILDS a URL. Every rule about what a search means — the union of
 * suburbs, the centre looked up on the server, one `loc` becoming `suburb` —
 * lives in packages/core and the results page, not here.
 */

export type Tab = 'buy' | 'rent' | 'build' | 'sold' | 'address' | 'agents';

const TABS: { id: Tab; label: string; title: string }[] = [
  { id: 'buy', label: 'Buy', title: 'Search properties for sale' },
  { id: 'rent', label: 'Rent', title: 'Search properties for rent' },
  { id: 'build', label: 'Build', title: 'Search new homes and house-and-land' },
  { id: 'sold', label: 'Sold', title: 'Search recently sold properties' },
  { id: 'address', label: 'Address', title: 'Find a property by its address' },
  { id: 'agents', label: 'Agents', title: 'Find a local agent' },
];

export type Chip = PlaceRef & { label: string };
/** A region or a street address: a point with a circle, never a chip beside suburbs. */
export type Point = { label: string; lat: number; lng: number };
export type Filters = {
  types: string[];
  beds: string;
  baths: string;
  cars: string;
  priceFrom: string;
  priceTo: string;
};
type Recent = { label: string; detail: string; href: string };

export const NO_FILTERS: Filters = { types: [], beds: '', baths: '', cars: '', priceFrom: '', priceTo: '' };
const SALE_PRICES = [200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000, 1_250_000, 1_500_000, 2_000_000, 3_000_000, 5_000_000];
const RENT_PRICES = [150, 200, 300, 400, 500, 600, 700, 800, 1000, 1500, 2000];
const TYPE_LABELS: Record<string, string> = {
  house: 'House', apartment: 'Apartment', unit: 'Unit', townhouse: 'Townhouse', villa: 'Villa',
  duplex: 'Duplex', studio: 'Studio', acreage: 'Acreage', land: 'Land', rural: 'Rural', other: 'Other',
};
const RECENT_KEY = 'lah:recent-searches';
const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;
/** What the empty box types out as examples, per kind of search. */
const TYPED = {
  place: ['Pakenham, VIC 3810', 'Richmond, VIC', 'within 10 km of Berwick', 'Bondi Beach, NSW', 'postcode 3806'],
  address: ['14 Rogers Street, Pakenham', '5 Station Street, Officer', 'Unit 2, 30 High Street, Berwick'],
  agents: ['Berwick', '3806', 'an agency name'],
  ai: ['a 3-bed family home near Berwick under $900k', 'a townhouse near a train station', 'land in Officer under $400k'],
};
/** Chips shown while the box is not in use; the rest are "+N more". */
const SHOWN_CHIPS = 2;
/** Answers already fetched this visit: Backspace, re-typing and tab switches cost no request. */
const SUGGESTED = new Map<string, PlaceSuggestion[]>();

const chipOf = (p: PlaceRef): Chip => ({
  ...p,
  label: [p.suburb, [p.state, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
});

function money(n: number, perWeek: boolean): string {
  if (perWeek) return `$${n.toLocaleString('en-AU')} pw`;
  return n >= 1_000_000 ? `$${n / 1_000_000}m` : `$${n / 1000}k`;
}

/** The distance steps, plus one typed that is not a step ("12 km"), in order. */
function kmSteps(extra?: number): number[] {
  return [...new Set([...DISTANCE_STEPS_KM, ...(extra && extra > 0 ? [extra] : [])])].sort((a, b) => a - b);
}

/** Browser storage can throw (private mode, blocked site data): recent searches are a convenience only. */
function readRecent(): Recent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? (raw as Recent[]).filter((r) => r && typeof r.href === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}
function saveRecent(entry: Recent) {
  try {
    const next = [entry, ...readRecent().filter((r) => r.href !== entry.href)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* nothing to do: the search still runs */
  }
}

/** The box's starting state; the results pages fill it from their URL (results-search.tsx). */
export type SearchStart = {
  tab: Tab;
  text: string;
  chips: Chip[];
  point: Point | null;
  radius: string;
  filters: Filters;
  /** Carried to the next search, not shown: the results page's own order. */
  sort?: string;
  /** Smart search's keywords (ADR 0101), from the results page's `kw`. */
  keywords?: string[];
};

export function HomeSearch({
  starters = [],
  variant = 'hero',
  start,
}: {
  starters?: readonly string[];
  /** `bar`: the box above /search and /sold results — no hero, title, tabs or AI toggle. */
  variant?: 'hero' | 'bar';
  start?: SearchStart;
}) {
  const router = useRouter();
  const id = useId();
  const bar = variant === 'bar';
  const [tab, setTab] = useState<Tab>(start?.tab ?? 'buy');
  const [ai, setAi] = useState(false);
  const [aiMenu, setAiMenu] = useState(false);
  const [text, setText] = useState(start?.text ?? '');
  const [chips, setChips] = useState<Chip[]>(start?.chips ?? []);
  const [point, setPoint] = useState<Point | null>(start?.point ?? null);
  const [radius, setRadius] = useState(start?.radius ?? '');
  const [filters, setFilters] = useState<Filters>(start?.filters ?? NO_FILTERS);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  /** Which lookup the list on screen answers; anything else is still on its way. */
  const [answered, setAnswered] = useState('');
  /** Set when Search was pressed on a sentence: search once its reading has landed in state. */
  const [searchNext, setSearchNext] = useState(false);
  /** ADR 0101 part 2: words to find in listing text, and asks we cannot search, both from the model and checked by core. */
  const [keywords, setKeywords] = useState<string[]>(start?.keywords ?? []);
  const [gaps, setGaps] = useState<string[]>([]);
  const [thinking, setThinking] = useState(false);
  /** The model already had its turn (or failed): the next submit searches with what is in the box. */
  const noAiOnce = useRef(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<Recent[]>([]);
  /** Looking a place up or asking the model: the button waits, typing does not. */
  const [going, startGoing] = useTransition();
  /** Leaving for the results: only then is the text box held still. */
  const [navigating, startNav] = useTransition();
  const boxRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLLabelElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const isPlaceTab = tab === 'buy' || tab === 'rent' || tab === 'build' || tab === 'sold';
  const maxChips = MAX_SEARCH_PLACES;
  // ADR 0101: the sentence read by rules, on every keystroke, with no request.
  const parsed = !ai && isPlaceTab ? parseSearchText(text) : null;
  const smart = parsed?.understood ? parsed : null;
  const travelTime = !ai && isPlaceTab && asksForTravelTime(text);
  const lookup = (smart ? (smart.places[0] ?? '') : text).trim();
  const wantsSuggestions =
    !ai && !travelTime && lookup.length >= MIN_CHARS && !(isPlaceTab && chips.length >= MAX_SEARCH_PLACES);
  const lookupKey = `${tab === 'address' ? 'address' : 'place'}|${lookup.toLowerCase()}`;
  const searching = wantsSuggestions && answered !== lookupKey;

  useEffect(() => setRecent(readRecent()), []);

  // A new chip pushes the input right: scroll it back into view.
  useEffect(() => {
    const field = fieldRef.current;
    if (field) field.scrollLeft = field.scrollWidth;
  }, [chips.length, point]);

  // Suggestions: from memory at once, otherwise debounced, and a request
  // overtaken by more typing is aborted. A failure is silent: the box still
  // searches by keyword.
  useEffect(() => {
    if (!wantsSuggestions) {
      setSuggestions([]);
      return;
    }
    const key = lookupKey;
    const show = (found: PlaceSuggestion[]) => {
      setSuggestions(found);
      setActive(-1);
      setAnswered(key);
    };
    const known = SUGGESTED.get(key);
    if (known) return show(known);
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/places?q=${encodeURIComponent(lookup)}${tab === 'address' ? '&kind=address' : ''}`,
          { signal: abort.signal },
        );
        // A refusal (rate limit) is not remembered: the next keystroke may get through.
        if (!res.ok) return show([]);
        const found = ((await res.json()) as { suggestions?: PlaceSuggestion[] }).suggestions ?? [];
        if (SUGGESTED.size > 200) SUGGESTED.clear();
        SUGGESTED.set(key, found);
        show(found);
      } catch {
        /* aborted by more typing, or offline: keyword search still works */
        if (!abort.signal.aborted) show([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [wantsSuggestions, lookupKey, lookup, tab]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setAiMenu(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function switchTab(next: Tab) {
    if ((next === 'rent') !== (tab === 'rent')) setFilters((f) => ({ ...f, priceFrom: '', priceTo: '' }));
    setTab(next);
    setText('');
    setSuggestions([]);
    // /sold names suburbs only, so a region or address point does not carry over.
    if (next === 'sold') setPoint(null);
    if (next === 'address' || next === 'agents') {
      setPoint(null);
      setRadius('');
    }
  }

  async function resolve(s: PlaceSuggestion): Promise<ResolvedPlace | null> {
    try {
      const res = await fetch(`/api/places?id=${encodeURIComponent(s.id)}`);
      if (!res.ok) return null;
      return ((await res.json()) as { place?: ResolvedPlace | null }).place ?? null;
    } catch {
      return null;
    }
  }

  /** The distance a new chip starts with: the Distance control's, unless the sentence said its own. */
  const defaultKm = radius ? Number(radius) : undefined;

  function addChip(chip: Chip) {
    setPoint(null);
    setChips((c) => {
      const same = c.findIndex((x) => placeOnly(x) === placeOnly(chip));
      // Picked again with its own distance ("20 km pakenham"): that suburb takes it, the others keep theirs.
      if (same >= 0) return chip.km && c[same]!.km !== chip.km ? c.map((x, i) => (i === same ? { ...x, km: chip.km } : x)) : c;
      return c.length >= maxChips ? c : [...c, chip];
    });
  }

  /** One suburb's own distance, from the select on its chip. */
  function setChipKm(chip: Chip, value: string) {
    setChips((all) => all.map((x) => (placeOnly(x) === placeOnly(chip) ? { ...x, km: value ? Number(value) : undefined } : x)));
  }

  function choose(s: PlaceSuggestion) {
    if (smart) return applySmart(smart, s);
    const typedKm = undefined;
    const typed = text;
    setSuggestions([]);
    setOpen(false);

    // A suburb is a chip at once: the server finds its centre on search.
    const instant = tab === 'address' ? null : suggestionToPlace(s);
    if (instant && tab === 'agents') {
      go(`/agents?loc=${encodeURIComponent(formatLoc(instant))}`, { label: `Agents in ${s.label}`, detail: '' });
      return;
    }
    if (instant) {
      setText('');
      addChip(chipOf({ ...instant, km: typedKm ?? defaultKm }));
      if (typedKm) setRadius(String(typedKm));
      inputRef.current?.focus();
      return;
    }

    // Anything else needs its coordinates first; the button shows the wait,
    // and a failed lookup gives back what was typed.
    setText('');
    startGoing(async () => {
      const place = await resolve(s);
      if (!place) {
        setText(typed);
        inputRef.current?.focus();
        return;
      }
      applyPlace(s, place, typedKm);
    });
  }

  /** The first suggestion for some place words, from memory when this visit already asked. */
  async function suggestFor(words: string): Promise<PlaceSuggestion | undefined> {
    const key = `place|${words.trim().toLowerCase()}`;
    const known = SUGGESTED.get(key);
    if (known) return known[0];
    try {
      const res = await fetch(`/api/places?q=${encodeURIComponent(words.trim())}`);
      if (!res.ok) return undefined;
      const found = ((await res.json()) as { suggestions?: PlaceSuggestion[] }).suggestions ?? [];
      SUGGESTED.set(key, found);
      return found[0];
    } catch {
      return undefined;
    }
  }

  /**
   * Set everything a sentence said: its places as chips, Distance, Filters, and
   * the Rent or Build tab when it asked for one. Searching stays a separate
   * step unless `thenSearch` (the Search button was pressed on the sentence).
   */
  function applySmart(
    p: ParsedSearch,
    firstPick?: PlaceSuggestion,
    thenSearch = false,
    opts: { sentence?: string; fromAi?: boolean } = {},
  ) {
    const sentence = opts.sentence ?? text;
    setSuggestions([]);
    setOpen(false);
    setText('');
    // Sold stays Sold; otherwise the sentence's own words choose the tab. Not
    // switchTab: that clears the price this is about to set.
    const nextTab: Tab =
      tab === 'sold' ? 'sold' : p.channel === 'rent' ? 'rent' : p.newBuild ? 'build' : p.channel === 'sale' && tab === 'rent' ? 'buy' : tab;
    if (nextTab !== tab) setTab(nextTab);
    if (p.km) setRadius(String(p.km));
    // The tab decides what a small number means: $600 is rent on Rent, and no price at all for a home to buy.
    const priceFrom = plausiblePrice(p.priceFrom, nextTab === 'rent');
    const priceTo = plausiblePrice(p.priceTo, nextTab === 'rent');
    setFilters((f) => ({
      ...f,
      ...(p.types.length ? { types: p.types } : {}),
      ...(p.beds ? { beds: String(p.beds) } : {}),
      ...(p.baths ? { baths: String(p.baths) } : {}),
      ...(p.cars ? { cars: String(p.cars) } : {}),
      ...(priceFrom ? { priceFrom: String(priceFrom) } : {}),
      ...(priceTo ? { priceTo: String(priceTo) } : {}),
    }));
    if (!p.places.length) {
      if (thenSearch) setSearchNext(true);
      inputRef.current?.focus();
      return;
    }
    startGoing(async () => {
      const missing: string[] = [];
      for (const [i, words] of p.places.entries()) {
        const s = i === 0 && firstPick ? firstPick : await suggestFor(words);
        let ref: PlaceRef | null = s ? suggestionToPlace(s) : null;
        if (s && !ref) {
          const place = await resolve(s);
          if (place?.suburb && (place.kind === 'locality' || place.kind === 'postcode')) {
            ref = { suburb: place.suburb, state: place.state ?? undefined, postcode: place.postcode ?? undefined };
          } else if (place && p.places.length === 1 && nextTab !== 'sold') {
            // A region on its own: a point with its own circle, as a picked region is.
            setChips([]);
            setPoint({ label: s.label, lat: place.latitude, lng: place.longitude });
            if (!p.km) setRadius(String(DEFAULT_RADIUS_KM[place.kind]));
            continue;
          }
        }
        // This sentence's distance goes on this sentence's places; earlier chips keep theirs.
        if (ref) addChip(chipOf({ ...ref, km: p.km ?? defaultKm }));
        else missing.push(words);
      }
      // Words that are not a place: the model reads the whole sentence once; if it
      // cannot, they go back in the box, where the list says so.
      const putBack = () => {
        setText(missing.join(', '));
        setOpen(true);
      };
      if (missing.length && !opts.fromAi) {
        understandWithAi(sentence, thenSearch, putBack);
      } else if (missing.length) {
        putBack();
      } else if (thenSearch) {
        setSearchNext(true);
      }
      inputRef.current?.focus();
    });
  }

  /**
   * The model reads a sentence the rules could not finish (ADR 0101 part 2).
   * Everything it returns was checked by core against the sentence; on any
   * failure the box carries on without it.
   */
  function understandWithAi(sentence: string, thenSearch: boolean, fallback: () => void) {
    setThinking(true);
    startGoing(async () => {
      try {
        const res = await fetch('/api/search/understand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentence.slice(0, MAX_UNDERSTAND_CHARS) }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const u = (await res.json()) as UnderstoodSearch;
        if (!u.places?.length && !u.understood) throw new Error('nothing read');
        setKeywords(u.keywords ?? []);
        setGaps(u.notSearchable ?? []);
        applySmart(u, undefined, thenSearch, { sentence, fromAi: true });
      } catch {
        fallback();
      } finally {
        setThinking(false);
      }
    });
  }

  // The Search button on a sentence: search once its reading is in state.
  useEffect(() => {
    if (!searchNext || going) return;
    setSearchNext(false);
    submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on the flag; submit reads the state that just landed
  }, [searchNext, going]);

  function applyPlace(s: PlaceSuggestion, place: ResolvedPlace, typedKm: number | undefined) {
    if (tab === 'agents') {
      const ref = place?.suburb
        ? { suburb: place.suburb, state: place.state ?? undefined, postcode: place.postcode ?? undefined }
        : null;
      go(ref ? `/agents?loc=${encodeURIComponent(formatLoc(ref))}` : `/agents?q=${encodeURIComponent(s.label)}`, {
        label: `Agents in ${s.label}`,
        detail: '',
      });
      return;
    }

    if (tab === 'address') {
      const params = new URLSearchParams({
        lat: place.latitude.toFixed(6),
        lng: place.longitude.toFixed(6),
      });
      for (const [key, value] of [
        ['unit', place.unit],
        ['number', place.streetNumber],
        ['street', place.street],
        ['suburb', place.suburb],
        ['state', place.state],
        ['postcode', place.postcode],
      ] as const) {
        if (value) params.set(key, value);
      }
      go(`/address?${params}`, { label: place.formatted, detail: 'Address' });
      return;
    }

    // A suburb or postcode becomes a chip; a region or anything without a
    // suburb is a point with its own sensible circle, and stands alone.
    if (place.suburb && (place.kind === 'locality' || place.kind === 'postcode')) {
      addChip(
        chipOf({
          suburb: place.suburb,
          state: place.state ?? undefined,
          postcode: place.postcode ?? undefined,
          km: typedKm ?? defaultKm,
        }),
      );
    } else if (tab !== 'sold') {
      // /sold names suburbs only: it never takes coordinates from a URL.
      setChips([]);
      setPoint({ label: s.label, lat: place.latitude, lng: place.longitude });
      if (!typedKm) setRadius(String(DEFAULT_RADIUS_KM[place.kind]));
    }
    if (typedKm) setRadius(String(typedKm));
    inputRef.current?.focus();
  }

  function go(href: string, entry: Omit<Recent, 'href'>) {
    saveRecent({ ...entry, href });
    setOpen(false);
    startNav(() => router.push(href));
  }

  const perWeek = tab === 'rent';
  const filterCount =
    (filters.types.length ? 1 : 0) +
    (filters.beds ? 1 : 0) +
    (filters.baths ? 1 : 0) +
    (filters.cars ? 1 : 0) +
    (filters.priceFrom || filters.priceTo ? 1 : 0);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const typed = text.trim();

    if (ai) {
      if (typed) startNav(() => router.push(`/chat?ask=${encodeURIComponent(typed.slice(0, 1000))}`));
      return;
    }
    // A sentence ("pakenham 10km 3 bed"): set what it says, then search.
    if (smart) return applySmart(smart, smart.places.length ? suggestions[0] : undefined, true);
    if (tab === 'address' || tab === 'agents') {
      if (suggestions[0]) return void choose(suggestions[0]);
      if (tab === 'agents' && typed) go(`/agents?q=${encodeURIComponent(typed)}`, { label: `Agents: ${typed}`, detail: '' });
      return;
    }

    // A sentence the box could not place ("family home near good schools in
    // berwick"): the model reads it before it becomes a keyword search.
    const skipAi = noAiOnce.current;
    noAiOnce.current = false;
    if (!skipAi && !chips.length && !point && typed.split(/\s+/).length >= 3 && !suggestions.length) {
      return understandWithAi(typed, true, () => {
        noAiOnce.current = true;
        setSearchNext(true);
      });
    }

    const params = new URLSearchParams();
    if (tab === 'buy' || tab === 'build') params.set('channel', 'sale');
    if (tab === 'rent') params.set('channel', 'rent');
    if (tab === 'build') params.set('new', '1');

    for (const c of chips) params.append('loc', formatLoc(c));
    if (point) {
      params.set('lat', point.lat.toFixed(6));
      params.set('lng', point.lng.toFixed(6));
    }
    // Each suburb's distance rides in its own `loc`; the shared radius is only for a point.
    if (radius && point) params.set('radius', radius);
    if (!chips.length && !point && typed) params.set('q', typed);
    // /sold has no keyword filter; /search matches each in the listing's own words.
    if (tab !== 'sold') for (const k of keywords) params.append('kw', k);

    for (const t of filters.types) params.append('type', t);
    if (filters.beds) params.set('beds', filters.beds);
    if (filters.baths) params.set('baths', filters.baths);
    if (filters.cars) params.set('cars', filters.cars);
    if (filters.priceFrom) params.set('priceFrom', filters.priceFrom);
    if (filters.priceTo) params.set('priceTo', filters.priceTo);
    if (start?.sort) params.set('sort', start.sort);

    const where = point ? [point.label] : chips.map((c) => c.label);
    const detail = [
      TABS.find((t) => t.id === tab)?.label ?? '',
      point && radius ? `+ within ${radius} km` : chipKm === 'mixed' ? 'distance per suburb' : chipKm ? `+ within ${chipKm} km` : '',
      filters.beds ? `${filters.beds}+ beds` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    go(`${tab === 'sold' ? '/sold' : '/search'}?${params}`, {
      label: where.length ? where.join(' · ') : typed || 'Everywhere',
      detail,
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !text && (chips.length || point)) {
      if (point) setPoint(null);
      else setChips((c) => c.slice(0, -1));
      return;
    }
    if (e.key === 'Escape') return setOpen(false);
    const offset = smart ? 1 : 0;
    const count = offset + suggestions.length;
    if (!count) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => ((i < 0 ? activeIdx : i) + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => ((i < 0 ? activeIdx : i) <= 0 ? count - 1 : (i < 0 ? activeIdx : i) - 1));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      if (smart && activeIdx === 0) applySmart(smart, suggestions[0]);
      else if (suggestions[activeIdx - offset]) choose(suggestions[activeIdx - offset]!);
    }
  }

  const title = ai ? 'Describe the home you want' : TABS.find((t) => t.id === tab)?.title;
  /** The suburbs' shared distance, '' for none, or 'mixed' when each has its own. */
  const chipKm = (() => {
    const kms = chips.map((c) => (c.km ? String(c.km) : ''));
    return kms.every((k) => k === kms[0]) ? (kms[0] ?? '') : 'mixed';
  })();
  /** With a reading on screen, it is the option Enter takes unless the user moved. */
  const activeIdx = active === -1 && smart && open ? 0 : active;
  const smartPills = smart ? readingPills(smart, suggestions[0], lookup, answered === lookupKey) : [];
  const placeholder = ai
    ? 'e.g. a 3-bed family home near Berwick under $900k'
    : tab === 'address'
      ? 'Enter a street address, e.g. 14 Rogers Street, Pakenham'
      : tab === 'agents'
        ? 'Suburb, postcode, or an agent or agency name'
        : chips.length
          ? chips.length >= maxChips
            ? ''
            : 'Add another suburb'
          : 'Search suburb, postcode or region';
  const typing = !text && !chips.length && !point;
  const examples = ai ? TYPED.ai : tab === 'address' ? TYPED.address : tab === 'agents' ? TYPED.agents : TYPED.place;

  // The empty box types out examples. Written straight to the input's
  // placeholder, not through state: a re-render of the whole box every 60 ms
  // is the cost the user asked us to remove. React only writes the attribute
  // when `placeholder` itself changes, and this effect restarts from it then.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.placeholder = placeholder;
    if (!typing || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let shown = placeholder;
    let target = '';
    let item = 0;
    let deleting = true;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      if (deleting) {
        shown = shown.slice(0, -1);
        if (!shown) {
          deleting = false;
          target = `Try ${examples[item]}`;
          item = (item + 1) % examples.length;
        }
        el.placeholder = shown;
        timer = setTimeout(step, shown ? 25 : 300);
        return;
      }
      shown = target.slice(0, shown.length + 1);
      el.placeholder = shown;
      if (shown === target) deleting = true;
      timer = setTimeout(step, deleting ? 1800 : 60);
    };
    // The plain hint first, so the box says what it is before it shows examples.
    timer = setTimeout(step, 2000);
    return () => clearTimeout(timer);
  }, [typing, examples, placeholder]);

  const listId = `${id}-list`;
  const showDistance = !ai && isPlaceTab;
  const placed = chips.length > 0 || point !== null;
  const typedPlaceAfterFrom = text.split(/\bfrom\b/i)[1]?.trim();

  return (
    <div className={bar ? styles.bar : styles.wrap} ref={boxRef}>
      {bar ? null : <h1 className={styles.title}>{title}</h1>}

      <div className={styles.card}>
        {!ai && !bar ? (
          <div className={styles.tabs} role="tablist" aria-label="What are you searching for">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? `${styles.tab} ${styles.tabOn}` : styles.tab}
                onClick={() => switchTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : null}

        <form className={styles.row} onSubmit={submit} role="search">
          {/* A label, so a click anywhere in the field focuses the input natively. Tied to the input by id:
              the chips' distance selects come first, and a bare label would take the first of those. */}
          <label className={styles.field} ref={fieldRef} htmlFor={`${id}-q`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className={styles.glass}>
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" />
            </svg>
            {!ai && isPlaceTab
              ? chips.map((c, i) => (
                  // Past the second (the first on a phone), a chip waits behind "+N more" until the box is in use.
                  <span
                    key={placeOnly(c)}
                    className={styles.chip}
                    data-extra={i >= SHOWN_CHIPS ? '' : undefined}
                    data-extra-narrow={i >= 1 ? '' : undefined}
                  >
                    {c.label}
                    {/* This suburb's own distance: changing it moves no other chip. */}
                    <select
                      className={styles.chipKm}
                      aria-label={`Distance around ${c.label}`}
                      value={c.km ?? ''}
                      onChange={(e) => setChipKm(c, e.target.value)}
                    >
                      <option value="">+0 km</option>
                      {kmSteps(c.km).map((km) => (
                        <option key={km} value={km}>
                          +{km} km
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={`Remove ${c.label}`}
                      onClick={() => setChips((all) => all.filter((x) => x !== c))}
                    >
                      ×
                    </button>
                  </span>
                ))
              : null}
            {!ai && isPlaceTab && chips.length > SHOWN_CHIPS ? (
              <span className={`${styles.more} ${styles.wideOnly}`}>+{chips.length - SHOWN_CHIPS} more</span>
            ) : null}
            {!ai && isPlaceTab && chips.length > 1 ? (
              <span className={`${styles.more} ${styles.narrowOnly}`}>+{chips.length - 1} more</span>
            ) : null}
            {!ai && isPlaceTab && point ? (
              <span className={styles.chip}>
                {point.label}
                <button type="button" aria-label={`Remove ${point.label}`} onClick={() => setPoint(null)}>
                  ×
                </button>
              </span>
            ) : null}
            <input
              id={`${id}-q`}
              ref={inputRef}
              className={styles.input}
              value={text}
              placeholder={placeholder}
              aria-label={title}
              autoComplete="off"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              maxLength={ai ? 1000 : 200}
              // Held only while leaving for the results; a place lookup must not eat the next suburb's keys.
              // readOnly, not disabled: a disabled input drops focus.
              readOnly={navigating}
              onChange={(e) => {
                setText(e.target.value);
                setOpen(true);
              }}
              onClick={() => setOpen(true)}
              // Back to the first chips, beside "+N more", once the box is put down.
              onBlur={() => fieldRef.current?.scrollTo({ left: 0 })}
              onFocus={() => {
                setOpen(true);
                setRecent(readRecent());
              }}
              onKeyDown={onKeyDown}
            />
          </label>
          {!ai && isPlaceTab ? (
            <button
              type="button"
              className={filterCount ? `${styles.filters} ${styles.filtersOn}` : styles.filters}
              onClick={() => dialogRef.current?.showModal()}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {filterCount ? `Filters · ${filterCount}` : 'Filters'}
            </button>
          ) : null}
          <button type="submit" className={styles.go} disabled={going || navigating} aria-busy={going || navigating}>
            {going || navigating ? <Spinner /> : null}
            {thinking ? 'Understanding…' : ai ? 'Ask the guide' : 'Search'}
          </button>
        </form>

        {showDistance ? (
          <div className={styles.distance}>
            <label htmlFor={`${id}-km`}>Distance</label>
            <select
              id={`${id}-km`}
              value={!placed ? '' : point ? radius : chipKm}
              disabled={!placed}
              title={placed ? 'Sets every suburb; each chip can have its own' : 'Pick a suburb first'}
              onChange={(e) => {
                if (e.target.value === 'mixed') return;
                setRadius(e.target.value);
                // Every suburb at once; a chip's own select changes just that one afterwards.
                setChips((all) => all.map((c) => ({ ...c, km: e.target.value ? Number(e.target.value) : undefined })));
              }}
            >
              <option value="">{point ? 'Around this place' : placed ? 'Only these suburbs' : 'Pick a suburb first'}</option>
              {chipKm === 'mixed' ? (
                <option value="mixed" disabled>
                  Different per suburb
                </option>
              ) : null}
              {kmSteps(point ? defaultKm : chipKm && chipKm !== 'mixed' ? Number(chipKm) : undefined).map((km) => (
                <option key={km} value={km}>
                  + within {km} km
                </option>
              ))}
            </select>
            {chipKm && chipKm !== 'mixed' && chips.length > 1 ? <span className={styles.muted}>of each suburb</span> : null}
            {tab !== 'sold' && (keywords.length || gaps.length) ? (
              // What the model added, on this one line so nothing below moves.
              <span className={styles.aiNote}>
                <span aria-hidden>✦</span>
                {keywords.map((k) => (
                  <span key={k} className={styles.kwChip}>
                    &ldquo;{k}&rdquo;
                    <button type="button" aria-label={`Remove ${k}`} onClick={() => setKeywords((all) => all.filter((x) => x !== k))}>
                      ×
                    </button>
                  </span>
                ))}
                {gaps.length ? (
                  <span className={styles.gaps} title={`We can't search these yet: ${gaps.join(', ')}`}>
                    Not searchable yet: {gaps.join(', ')}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null}

        {open ? (
          <div className={styles.drop} id={listId}>
            {ai ? (
              text.trim() ? null : (
                <>
                  <p className={styles.dropHead}>Try asking</p>
                  <div className={styles.pills}>
                    {starters.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={styles.pill}
                        onClick={() => startNav(() => router.push(`/chat?ask=${encodeURIComponent(s)}`))}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </>
              )
            ) : travelTime ? (
              <p className={styles.notice}>
                Travel time isn&apos;t something we can search yet: we don&apos;t have walking or
                driving times.{' '}
                {typedPlaceAfterFrom ? (
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => setText(`within 2 km of ${typedPlaceAfterFrom}`)}
                  >
                    Search within 2 km of {typedPlaceAfterFrom}
                  </button>
                ) : (
                  'Try "within 2 km of" a suburb instead.'
                )}
              </p>
            ) : smart ? (
              <ul role="listbox" className={styles.list}>
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={activeIdx === 0}
                    className={activeIdx === 0 ? `${styles.option} ${styles.optionOn}` : styles.option}
                    onMouseEnter={() => setActive(0)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applySmart(smart, suggestions[0])}
                  >
                    <span className={styles.optionIcon} aria-hidden>
                      ✦
                    </span>
                    <span className={styles.optionMain}>
                      <span className={styles.reading}>
                        {smartPills.map((pill) => (
                          <span key={pill} className={styles.pill}>
                            {pill}
                          </span>
                        ))}
                      </span>
                      <span className={styles.optionSub}>Press Enter to set these</span>
                    </span>
                    <span className={styles.kind}>Smart</span>
                  </button>
                </li>
                {suggestions.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={activeIdx === i + 1}
                      className={activeIdx === i + 1 ? `${styles.option} ${styles.optionOn}` : styles.option}
                      onMouseEnter={() => setActive(i + 1)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(s)}
                    >
                      <span className={styles.optionIcon} aria-hidden>
                        {s.kind === 'postcode' ? '#' : '◉'}
                      </span>
                      <span className={styles.optionMain}>
                        {s.label}
                        {s.secondary ? <span className={styles.optionSub}>{s.secondary}</span> : null}
                      </span>
                      <span className={styles.kind}>{s.kind === 'locality' ? 'Suburb' : s.kind}</span>
                    </button>
                  </li>
                ))}
                {searching ? (
                  <li className={styles.hint} role="status">
                    <Spinner /> Searching places…
                  </li>
                ) : null}
              </ul>
            ) : suggestions.length ? (
              <>
                <ul role="listbox" className={styles.list}>
                  {suggestions.map((s, i) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        className={i === active ? `${styles.option} ${styles.optionOn}` : styles.option}
                        onMouseEnter={() => setActive(i)}
                        // Focus stays in the input, so a pick does not blur and re-open the box.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void choose(s)}
                      >
                        <span className={styles.optionIcon} aria-hidden>
                          {s.kind === 'address' ? '⌖' : s.kind === 'postcode' ? '#' : '◉'}
                        </span>
                        <span className={styles.optionMain}>
                          {tab === 'agents' ? `Agents in ${s.label}` : s.label}
                          {s.secondary ? <span className={styles.optionSub}>{s.secondary}</span> : null}
                        </span>
                        {tab !== 'agents' ? <span className={styles.kind}>{s.kind === 'locality' ? 'Suburb' : s.kind}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : !text.trim() && isPlaceTab && recent.length ? (
              <>
                <p className={styles.dropHead}>Recent searches</p>
                <ul className={styles.list}>
                  {recent.map((r) => (
                    <li key={r.href}>
                      <button
                        type="button"
                        className={styles.option}
                        onClick={() => startNav(() => router.push(r.href))}
                      >
                        <span className={styles.optionIcon} aria-hidden>
                          ↺
                        </span>
                        <span className={styles.optionMain}>
                          {r.label}
                          {r.detail ? <span className={styles.optionSub}>{r.detail}</span> : null}
                        </span>
                        <span aria-hidden>›</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : searching ? (
              <p className={styles.hint} role="status">
                <Spinner /> Searching places…
              </p>
            ) : wantsSuggestions ? (
              <p className={styles.hint}>
                {tab === 'address'
                  ? `No address matches "${lookup}". Check the street and suburb.`
                  : tab === 'agents'
                    ? `No suburb matches "${lookup}". Press Search to look for an agent or agency by that name.`
                    : `No suburb matches "${lookup}". Press Search to look for it in listings instead.`}
              </p>
            ) : !text.trim() ? (
              <p className={styles.hint}>
                {tab === 'address'
                  ? "Type a street address to see that property: what it sold for, and what's listed."
                  : tab === 'agents'
                    ? 'Search a suburb to see the agents selling there.'
                    : 'Pick suburbs, or type it all: "pakenham 10km 3 bed house under 800k".'}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {bar ? null : (
      <div className={styles.aiWrap}>
        <button
          type="button"
          className={styles.aiToggle}
          aria-expanded={aiMenu}
          onClick={() => setAiMenu((v) => !v)}
        >
          <span className={styles.beta}>Beta</span>
          Guide chat: {ai ? 'On' : 'Off'}
          <span aria-hidden>▾</span>
        </button>
        {aiMenu ? (
          <div className={styles.aiMenu}>
            {[false, true].map((on) => (
              <button
                key={String(on)}
                type="button"
                aria-pressed={ai === on}
                className={ai === on ? `${styles.aiOption} ${styles.aiOptionOn}` : styles.aiOption}
                onClick={() => {
                  setAi(on);
                  setAiMenu(false);
                  setText('');
                  router.prefetch('/chat');
                }}
              >
                <b>{on ? 'On: ask the property guide' : 'Off: smart search'}</b>
                <small>
                  {on
                    ? 'Describe it in a sentence. Prices and counts still come from live listings, never from the model.'
                    : 'Type it as you would say it, "pakenham 10km 3 bed under 800k", or pick suburbs and filters. Every result is a live listing.'}
                </small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      )}

      <dialog ref={dialogRef} className={styles.dialog} aria-label="Filters">
        <form method="dialog">
          <header className={styles.dialogHead}>
            <b>Filters</b>
            <button type="submit" aria-label="Close" className={styles.close}>
              ×
            </button>
          </header>
          <div className={styles.dialogBody}>
            <fieldset className={styles.group}>
              <legend>Property type</legend>
              <div className={styles.seg}>
                <button
                  type="button"
                  aria-pressed={!filters.types.length}
                  onClick={() => setFilters((f) => ({ ...f, types: [] }))}
                >
                  All types
                </button>
                {PROPERTY_TYPES.filter((t) => t !== 'other').map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={filters.types.includes(t)}
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t],
                      }))
                    }
                  >
                    {TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className={styles.group}>
              <legend>{perWeek ? 'Price per week' : tab === 'sold' ? 'Sold price' : 'Price'}</legend>
              <div className={styles.two}>
                {(['priceFrom', 'priceTo'] as const).map((key) => (
                  <select
                    key={key}
                    aria-label={key === 'priceFrom' ? 'Minimum price' : 'Maximum price'}
                    value={filters[key]}
                    onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))}
                  >
                    <option value="">{key === 'priceFrom' ? 'Min: Any' : 'Max: Any'}</option>
                    {[...new Set([...(perWeek ? RENT_PRICES : SALE_PRICES), ...(filters[key] ? [Number(filters[key])] : [])])]
                      .sort((a, b) => a - b)
                      .map((n) => (
                      <option key={n} value={n}>
                        {money(n, perWeek)}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            </fieldset>

            {(
              [
                ['beds', 'Bedrooms', ['1', '2', '3', '4', '5']],
                ['baths', 'Bathrooms', ['1', '2', '3']],
                ['cars', 'Car spaces', ['1', '2', '3']],
              ] as const
            ).map(([key, legend, steps]) => (
              <fieldset key={key} className={styles.group}>
                <legend>{legend}</legend>
                <div className={styles.seg}>
                  {['', ...steps].map((v) => (
                    <button
                      key={v || 'any'}
                      type="button"
                      aria-pressed={filters[key] === v}
                      onClick={() => setFilters((f) => ({ ...f, [key]: v }))}
                    >
                      {v ? `${v}+` : 'Any'}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <footer className={styles.dialogFoot}>
            <button type="button" className={styles.linkBtn} onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
            <button
              type="button"
              className={styles.go}
              onClick={() => {
                dialogRef.current?.close();
                submit();
              }}
            >
              Search
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

/** The sentence's reading as short pills: what Enter will set. */
function readingPills(p: ParsedSearch, first: PlaceSuggestion | undefined, lookup: string, firstAnswered: boolean): string[] {
  const perWeek = p.channel === 'rent';
  // A short name reads as a place; a long leftover is shown as typed, in quotes, since it may not be one.
  const place = (words: string) =>
    words.split(' ').length <= 3 ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : `\u201c${words}\u201d`;
  const firstPlace =
    first && firstAnswered && p.places[0]?.trim().toLowerCase() === lookup.toLowerCase()
      ? [first.label, first.secondary?.split(',')[0]].filter(Boolean).join(', ')
      : p.places[0] && place(p.places[0]);
  const price =
    p.priceFrom && p.priceTo
      ? `${money(p.priceFrom, perWeek)}–${money(p.priceTo, perWeek)}`
      : p.priceTo
        ? `under ${money(p.priceTo, perWeek)}`
        : p.priceFrom
          ? `from ${money(p.priceFrom, perWeek)}`
          : '';
  return [
    firstPlace ?? '',
    ...p.places.slice(1).map(place),
    p.km ? `within ${p.km} km` : '',
    p.channel === 'rent' ? 'For rent' : '',
    p.newBuild ? 'New homes' : '',
    p.types.map(typeLabel).join(' or '),
    p.beds ? `${p.beds}+ beds` : '',
    p.baths ? `${p.baths}+ baths` : '',
    p.cars ? `${p.cars}+ cars` : '',
    price,
  ].filter(Boolean);
}
