'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { MIN_QUERY_LENGTH, searchPlaces, type NominatimSuggestion } from '../../lib/geo/nominatim';
import type { Place } from '../../lib/booking/types';
import { WEB_POLICY } from '../../config/policy';

interface Props {
  label: string;
  placeholder?: string;
  value: Place | null;
  active?: boolean;
  testId?: string;
  onSelect: (place: Place) => void;
  onFocus?: () => void;
}

// Debounce keeps us within the Nominatim ≤1 req/s usage policy while typing.
const DEBOUNCE_MS = WEB_POLICY.search.addressDebounceMs;

export function AddressSearch({
  label,
  placeholder,
  value,
  active,
  testId,
  onSelect,
  onFocus,
}: Props) {
  const [text, setText] = useState(value?.label ?? '');
  const [suggestions, setSuggestions] = useState<NominatimSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  // Reflect an externally-set value (map tap, preset, swap) into the field.
  useEffect(() => {
    setText(value?.label ?? '');
  }, [value]);

  useEffect(() => {
    const q = text.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    // Don't re-search the label we just committed.
    if (value && q === value.label) return;

    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      searchPlaces(q, ctrl.signal)
        .then((res) => {
          setSuggestions(res);
          setOpen(true);
        })
        .catch(() => {
          /* aborted or network error — leave prior suggestions */
        })
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
      setLoading(false);
    };
  }, [text, value]);

  function choose(s: NominatimSuggestion) {
    onSelect({ lat: s.lat, lng: s.lng, label: s.label });
    setSuggestions([]);
    setOpen(false);
  }

  return (
    <div className="relative">
      <label
        className={clsx('text-sm font-semibold', active ? 'text-ink' : 'text-muted')}
      >
        {label}
      </label>
      <input
        data-testid={testId}
        type="text"
        value={text}
        placeholder={placeholder}
        aria-label={label}
        onFocus={onFocus}
        onChange={(e) => setText(e.target.value)}
        className={clsx(
          'mt-1 min-h-tap w-full rounded-control border bg-surface px-3 text-base placeholder:text-muted/70',
          active ? 'border-ink ring-1 ring-ink' : 'border-line-strong',
        )}
      />
      {loading && (
        <span className="absolute right-3 top-[38px] text-sm text-muted" aria-hidden="true">
          …
        </span>
      )}
      {open && suggestions.length > 0 && (
        <ul
          role="listbox"
          data-testid={testId ? `${testId}-suggestions` : undefined}
          className="absolute z-[1000] mt-1 w-full list-none rounded-control border border-line bg-surface p-1 shadow-lift"
        >
          {suggestions.map((s, i) => (
            <li key={`${s.lat},${s.lng},${i}`} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => choose(s)}
                className="block min-h-tap w-full rounded-[8px] px-3 py-2 text-left text-sm hover:bg-paper"
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
