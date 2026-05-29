'use client';

import { useEffect, useState } from 'react';
import { MIN_QUERY_LENGTH, searchPlaces, type NominatimSuggestion } from '../../lib/geo/nominatim';
import type { Place } from '../../lib/booking/types';

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
const DEBOUNCE_MS = 400;

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
    <div style={{ position: 'relative' }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: active ? '#111' : '#525252' }}>
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
        style={{
          width: '100%',
          padding: '8px 10px',
          marginTop: 4,
          fontSize: 14,
          borderRadius: 6,
          border: `1px solid ${active ? '#111' : '#d4d4d4'}`,
          boxSizing: 'border-box',
        }}
      />
      {loading && (
        <span style={{ position: 'absolute', right: 10, top: 30, fontSize: 12, color: '#737373' }}>
          …
        </span>
      )}
      {open && suggestions.length > 0 && (
        <ul
          role="listbox"
          data-testid={testId ? `${testId}-suggestions` : undefined}
          style={{
            listStyle: 'none',
            margin: '4px 0 0',
            padding: 4,
            border: '1px solid #e5e5e5',
            borderRadius: 6,
            background: '#fff',
            position: 'absolute',
            zIndex: 1000,
            width: '100%',
            boxSizing: 'border-box',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          }}
        >
          {suggestions.map((s, i) => (
            <li key={`${s.lat},${s.lng},${i}`} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => choose(s)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 8px',
                  fontSize: 13,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                }}
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
