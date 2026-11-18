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
      className="mt-3 rounded-control border border-amber bg-amber-wash px-3.5 py-3 text-sm text-amber-deep"
    >
      <div className="font-semibold">No co-rider found — continuing as private</div>
      <div className="mt-1">Updated fare: {formatMoney(soloFare)}</div>
    </div>
  );
}
