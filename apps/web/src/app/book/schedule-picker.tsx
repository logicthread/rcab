'use client';

import { useEffect, useState } from 'react';
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
      <div role="radiogroup" aria-label="Pickup time" style={{ display: 'flex', gap: 8 }}>
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
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid #d4d4d4',
              background: opt.selected ? '#111' : '#fafafa',
              color: opt.selected ? '#fff' : '#111',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {later && (
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 12, color: '#525252', display: 'block', marginBottom: 4 }}>
            Pickup date and time
            <input
              type="datetime-local"
              data-testid="schedule-input"
              value={toLocalInputValue(new Date(value))}
              min={bounds?.min}
              max={bounds?.max}
              disabled={disabled}
              onChange={(e) => onChange(fromLocalInputValue(e.target.value) ?? value)}
              style={{ display: 'block', marginTop: 4, fontSize: 14, padding: 6 }}
            />
          </label>
          <div style={{ fontSize: 12, color: '#737373' }}>
            We start looking for a driver about {Math.round(WEB_POLICY.booking.scheduleWakeLeadMs / 60_000)} minutes before pickup. You can cancel until the trip starts.
          </div>
          {error && (
            <div data-testid="schedule-error" style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
