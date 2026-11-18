'use client';

import { clsx } from 'clsx';
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
      className="flex gap-1 rounded-panel border border-line bg-surface p-1"
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
            className={clsx(
              'min-h-[56px] flex-1 rounded-[12px] px-3 py-2 text-left transition-colors duration-150 disabled:opacity-50',
              selected ? 'bg-ink text-on-ink' : 'text-ink hover:bg-paper',
            )}
          >
            <div className="font-semibold">{opt.label}</div>
            <div className={clsx('text-xs', selected ? 'text-on-ink/75' : 'text-muted')}>
              {opt.subtitle}
            </div>
          </button>
        );
      })}
    </div>
  );
}
