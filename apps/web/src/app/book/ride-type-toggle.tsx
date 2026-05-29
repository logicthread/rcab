'use client';

import type { RideType } from '../../lib/booking/types';

interface Props {
  value: RideType;
  onChange: (next: RideType) => void;
  disabled?: boolean;
}

const OPTIONS: Array<{ value: RideType; label: string; subtitle: string }> = [
  { value: 'shared', label: 'Share', subtitle: 'cheaper · co-rider may join' },
  { value: 'private', label: 'Private', subtitle: 'solo · no detour' },
];

export function RideTypeToggle({ value, onChange, disabled }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Ride type"
      style={{
        display: 'flex',
        gap: 8,
        border: '1px solid #d4d4d4',
        borderRadius: 8,
        padding: 4,
        background: '#fafafa',
      }}
    >
      {OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.label}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            style={{
              flex: 1,
              padding: '10px 12px',
              borderRadius: 6,
              border: 'none',
              cursor: disabled ? 'not-allowed' : 'pointer',
              background: selected ? '#111' : 'transparent',
              color: selected ? '#fff' : '#111',
              textAlign: 'left',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <div style={{ fontWeight: 600 }}>{opt.label}</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{opt.subtitle}</div>
          </button>
        );
      })}
    </div>
  );
}
