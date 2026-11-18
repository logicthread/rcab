'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { WEB_POLICY } from '../../config/policy';
import {
  defaultScheduleTime,
  fromLocalInputValue,
  scheduleBounds,
  toLocalInputValue,
  validateSchedule,
} from '../../lib/booking/schedule';

interface Props {
  /** ISO-8601 pickup instant, or null for "Now". */
  value: string | null;
  onChange: (iso: string | null) => void;
  disabled?: boolean;
}

/** "Now / Later" pickup-time choice for a private ride. "Later" reveals a date-time input bounded to the
 * server's scheduled window (15 min - 24 h out); the API re-validates (400 scheduled_for_out_of_window). */
export function SchedulePicker({ value, onChange, disabled }: Props) {
  const later = value !== null;
  // Bounds are computed on the client after mount (hydration-safe) and refreshed when "Later" is opened.
  const [bounds, setBounds] = useState<{ min: string; max: string } | null>(null);
  useEffect(() => {
    if (!later) return;
    const b = scheduleBounds();
    setBounds({ min: toLocalInputValue(b.min), max: toLocalInputValue(b.max) });
  }, [later]);

  const error = later ? validateSchedule(value) : null;
  const choose = (wantLater: boolean) => {
    if (wantLater === later) return;
    onChange(wantLater ? defaultScheduleTime().toISOString() : null);
  };

  return (
    <div data-testid="schedule-picker">
      <div
        role="radiogroup"
        aria-label="Pickup time"
        className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1"
      >
        {[
          { id: 'now', label: 'Now', selected: !later },
          { id: 'later', label: 'Later', selected: later },
        ].map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={opt.selected}
            aria-label={opt.label}
            data-testid={`schedule-${opt.id}`}
            disabled={disabled}
            onClick={() => choose(opt.id === 'later')}
            className={clsx(
              'min-h-tap min-w-[88px] rounded-[12px] px-5 font-semibold transition-colors duration-150 disabled:opacity-50',
              opt.selected ? 'bg-ink text-on-ink' : 'text-ink hover:bg-paper',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {later && (
        <div className="mt-3">
          <label className="block text-sm font-medium text-ink">
            Pickup date and time
            <input
              type="datetime-local"
              data-testid="schedule-input"
              value={toLocalInputValue(new Date(value))}
              min={bounds?.min}
              max={bounds?.max}
              disabled={disabled}
              onChange={(e) => onChange(fromLocalInputValue(e.target.value) ?? value)}
              className="mt-1 block min-h-tap w-full rounded-control border border-line-strong bg-surface px-3 text-base"
            />
          </label>
          <p className="mt-2 text-sm text-muted">
            We start looking for a driver about {Math.round(WEB_POLICY.booking.scheduleWakeLeadMs / 60_000)} minutes before pickup. You can cancel until the trip starts.
          </p>
          {error && (
            <div data-testid="schedule-error" className="mt-1 text-sm font-medium text-stop">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
