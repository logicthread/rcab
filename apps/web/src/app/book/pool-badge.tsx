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
      style={{
        marginTop: 12,
        padding: '10px 12px',
        background: '#ecfdf5',
        border: '1px solid #10b981',
        borderRadius: 8,
        color: '#065f46',
        fontSize: 14,
      }}
    >
      {others} other {noun} joining — your fare is ready
    </div>
  );
}
