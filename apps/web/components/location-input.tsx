'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { PlaceSuggestion, ResolvedPlace } from '@repo/core/geo/schema';
import styles from './location-input.module.css';

/** Below this, a query matches half the country and costs a request anyway. */
const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Fires with coordinates when a suggestion is picked, null when cleared. */
  onPlace: (place: ResolvedPlace | null) => void;
  placeholder?: string;
  /**
   * Submits under this name when the form is posted without JavaScript.
   *
   * The search bar is a real GET form, so this field has to carry the keyword
   * itself rather than being read out of React state on submit.
   */
  name?: string;
};

/**
 * The location half of the search box.
 *
 * Typing alone is a text search across suburb, street, headline and postcode.
 * Picking a suggestion adds coordinates, which is what turns on the radius —
 * so the two behaviours share one field and the user is never asked which
 * kind of search they meant.
 */
export function LocationInput({ value, onChange, onPlace, placeholder, name }: Props) {
  const id = useId();
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const applying = useRef(false);

  useEffect(() => {
    if (applying.current) {
      applying.current = false;
      return;
    }
    if (value.trim().length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/places?q=${encodeURIComponent(value.trim())}`);
        // 429 and friends: keep typing, keep searching by text. The field is
        // never blocked on this endpoint.
        if (!res.ok) return;
        const data = (await res.json()) as { suggestions?: PlaceSuggestion[] };
        if (cancelled) return;
        setSuggestions(data.suggestions ?? []);
        setOpen((data.suggestions ?? []).length > 0);
        setActive(-1);
      } catch {
        /* offline, or the request was replaced — text search still works */
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, []);

  async function choose(suggestion: PlaceSuggestion) {
    applying.current = true;
    onChange(suggestion.label);
    setOpen(false);
    setSuggestions([]);

    try {
      const res = await fetch(`/api/places?id=${encodeURIComponent(suggestion.id)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { place?: ResolvedPlace | null };
      // No coordinates is not a failure: the search falls back to matching the
      // suburb by name, which is what it did before there was a map at all.
      onPlace(data.place ?? null);
    } catch {
      onPlace(null);
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
      // Only when something is highlighted, so Enter still submits the search.
      event.preventDefault();
      const picked = suggestions[active];
      if (picked) void choose(picked);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className={styles.wrap} ref={boxRef}>
      <input
        id={id}
        name={name}
        className={styles.input}
        value={value}
        placeholder={placeholder ?? 'Suburb, postcode, street or keyword'}
        aria-label="Search by suburb, postcode, street or keyword"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          // Editing after picking invalidates the pin, or the radius would
          // still be centred on the place the user just typed away from.
          onPlace(null);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(suggestions.length > 0)}
      />

      {open && suggestions.length ? (
        <ul className={styles.list} id={`${id}-list`} role="listbox">
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
                {s.secondary ? <span className={styles.optionSub}>{s.secondary}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
