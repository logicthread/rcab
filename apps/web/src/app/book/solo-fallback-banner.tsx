'use client';

import type { Money } from '../../lib/booking/types';

interface Props {
  soloFare: Money | null;
}

function formatMoney(m: Money | null): string {
  if (!m) return '—';
  const rupees = (m.amount / 100).toFixed(2);
  return `₹${rupees}`;
}

export function SoloFallbackBanner({ soloFare }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="solo-fallback-banner"
      style={{
        marginTop: 12,
        padding: '12px 14px',
        background: '#fef3c7',
        border: '1px solid #f59e0b',
        borderRadius: 8,
        color: '#78350f',
        fontSize: 14,
      }}
    >
      <div style={{ fontWeight: 600 }}>No co-rider found — continuing as private</div>
      <div style={{ marginTop: 4 }}>Updated fare: {formatMoney(soloFare)}</div>
    </div>
  );
}
