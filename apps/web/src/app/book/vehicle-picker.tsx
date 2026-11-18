'use client';

import { clsx } from 'clsx';
import { VEHICLE_OPTIONS, type VehicleType } from '../../lib/booking/types';

interface Props {
  value: VehicleType;
  onChange: (next: VehicleType) => void;
  disabled?: boolean;
}

const ICONS: Record<VehicleType, string> = {
  bike: '🏍️',
  auto: '🛺',
  cab: '🚕',
  suv: '🚙',
  seater_6: '🚐',
};

/** Horizontal pick-a-vehicle row. Scrolls on narrow phones; one option is always selected. */
export function VehiclePicker({ value, onChange, disabled }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Vehicle"
      data-testid="vehicle-picker"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
    >
      {VEHICLE_OPTIONS.map((opt) => {
        const selected = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.label}
            data-testid={`vehicle-${opt.id}`}
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            className={clsx(
              'flex min-h-[84px] w-[92px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-panel border px-2 py-2 text-center transition-colors duration-150 disabled:opacity-50',
              selected
                ? 'border-ink bg-amber-wash ring-2 ring-ink'
                : 'border-line-strong bg-surface hover:bg-paper',
            )}
          >
            <span className="text-2xl leading-none" aria-hidden="true">
              {ICONS[opt.id]}
            </span>
            <span className="text-sm font-semibold">{opt.label}</span>
            <span className="text-xs text-muted">{opt.detail}</span>
          </button>
        );
      })}
    </div>
  );
}
