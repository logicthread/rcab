'use client';

interface Props {
  seatCount: number;
}

export function PoolBadge({ seatCount }: Props) {
  if (seatCount <= 1) return null;
  const others = seatCount - 1;
  const noun = others === 1 ? 'rider' : 'riders';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pool-badge"
      className="mt-3 rounded-control border border-go/40 bg-go-wash px-3 py-2.5 text-sm font-medium text-go"
    >
      Sharing with {others} other {noun}
    </div>
  );
}
