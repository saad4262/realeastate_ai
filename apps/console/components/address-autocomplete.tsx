'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { PlaceKind, PlaceSuggestion, ResolvedPlace } from '@repo/core/geo/schema';
import { resolvePlaceAction, suggestPlacesAction } from '@/lib/listing-actions';
import styles from './address-autocomplete.module.css';

/**
 * How long to wait after the last keystroke before asking the provider.
 *
 * Every request is billed, and a person typing "Campbell Parade" produces
 * fifteen of them at zero delay. 250 ms is below the point where the list
 * feels like it is lagging behind the typing.
 */
const DEBOUNCE_MS = 250;

type Props = {
  label: string;
  hint?: string;
  placeholder?: string;
  /** Which sorts of place to offer. Addresses for a listing, suburbs for a territory. */
  kinds?: PlaceKind[];
  /** What the field shows when the form opens — an existing listing's address. */
  defaultValue?: string;
  /**
   * Controlled text, for a field the form also writes to.
   *
   * The suburb picker needs this: choosing a full street address fills the
   * suburb, and a picker holding its own private copy of the text would sit
   * there still showing whatever was typed before.
   */
  value?: string;
  onChange?: (value: string) => void;
  /**
   * Fires when the user picks a suggestion and it resolves to coordinates.
   *
   * Providing it is what makes the component resolve at all. A territory
   * picker only wants the suburb's name, and resolving it would be a second
   * billed lookup for something already on screen.
   */
  onResolved?: (place: ResolvedPlace) => void;
  /** Fires as soon as a suggestion is picked, before any resolution. */
  onSelected?: (suggestion: PlaceSuggestion) => void;
  /** Empty the field after a pick — for a picker that builds a list. */
  clearOnSelect?: boolean;
  /** Fires when the field is cleared, so the form can drop a stale pin. */
  onCleared?: () => void;
};

/**
 * Address search that fills the form rather than replacing it.
 *
 * The individual address fields stay visible and editable underneath. Agents
 * list places the gazetteer does not know about — a new subdivision, a
 * renamed street — and a picker that is the only way in makes those
 * un-listable.
 */
export function AddressAutocomplete({
  label,
  hint,
  placeholder,
  kinds,
  defaultValue = '',
  value: controlledValue,
  onChange,
  onResolved,
  onSelected,
  clearOnSelect = false,
  onCleared,
}: Props) {
  const listId = useId();
  const [internalQuery, setInternalQuery] = useState(defaultValue);

  // Controlled when the parent supplies `value`, uncontrolled otherwise, so
  // the same component serves a standalone search box and a form field.
  const controlled = controlledValue !== undefined;
  const query = controlled ? controlledValue : internalQuery;
  const setQuery = (next: string) => {
    if (!controlled) setInternalQuery(next);
    onChange?.(next);
  };
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  /**
   * A failure worth showing.
   *
   * This used to be swallowed: the fetch sat in a try/finally with no catch, so
   * an expired session or a refused key emptied the dropdown and said nothing.
   * "No suggestions" and "the lookup failed" look identical to the user and
   * mean entirely different things.
   */
  const [failure, setFailure] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Set while a suggestion is being applied, so it does not re-search itself. */
  const applying = useRef(false);

  useEffect(() => {
    if (applying.current) {
      applying.current = false;
      return;
    }
    const value = query.trim();
    if (value.length < 3) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const results = await suggestPlacesAction(value, kinds);
        // An answer that arrives after the user has typed on is the wrong
        // answer; without this the list flickers back to a stale query.
        if (!cancelled) {
          setFailure(null);
          setSuggestions(results);
          setOpen(results.length > 0);
          setActive(-1);
        }
      } catch (err) {
        if (!cancelled) {
          setSuggestions([]);
          setOpen(false);
          setFailure(
            err instanceof Error && /signed in/i.test(err.message)
              ? 'Your session expired — reload the page to search addresses again.'
              : 'Address search is unavailable right now. You can still type the address.',
          );
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // kinds is a literal array at every call site, so depending on its identity
    // would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, []);

  async function choose(suggestion: PlaceSuggestion) {
    applying.current = true;
    setQuery(clearOnSelect ? '' : suggestion.label);
    setOpen(false);
    setSuggestions([]);
    onSelected?.(suggestion);

    if (!onResolved) return;

    setBusy(true);
    try {
      const place = await resolvePlaceAction(suggestion.id);
      if (place) {
        applying.current = true;
        setQuery(clearOnSelect ? '' : place.formatted || suggestion.label);
        onResolved(place);
      } else {
        setFailure('That place could not be looked up. Type the address instead.');
      }
    } catch {
      setFailure('That place could not be looked up. Type the address instead.');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || !suggestions.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === 'Enter' && active >= 0) {
      // Only swallow Enter when a suggestion is highlighted, so the key still
      // submits the form the rest of the time.
      event.preventDefault();
      const picked = suggestions[active];
      if (picked) void choose(picked);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className={styles.wrap} ref={boxRef}>
      <label className={styles.label} htmlFor={listId}>
        {label}
      </label>
      <div className={styles.inputRow}>
        <span className={styles.glyph} aria-hidden>
          search
        </span>
        <input
          id={listId}
          className={styles.input}
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${listId}-list`}
          aria-autocomplete="list"
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) onCleared?.();
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(suggestions.length > 0)}
        />
        {busy ? <span className={styles.spinner} aria-label="Searching" /> : null}
      </div>

      {failure ? (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      ) : hint ? (
        <p className={styles.hint}>{hint}</p>
      ) : null}

      {open && suggestions.length ? (
        <ul className={styles.list} id={`${listId}-list`} role="listbox">
          {suggestions.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={i === active ? `${styles.option} ${styles.optionOn}` : styles.option}
                onMouseEnter={() => setActive(i)}
                onClick={() => void choose(s)}
              >
                <span className={styles.optionMain}>{s.label}</span>
                {s.secondary ? (
                  <span className={styles.optionSub}>{s.secondary}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
