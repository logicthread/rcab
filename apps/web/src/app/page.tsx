import Link from 'next/link';

const LINK_STYLE = {
  display: 'inline-block',
  padding: '12px 20px',
  borderRadius: 8,
  textDecoration: 'none',
  fontWeight: 600,
  fontSize: 15,
} as const;

export default function HomePage() {
  return (
    <main
      style={{
        maxWidth: 520,
        margin: '72px auto',
        padding: 16,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 style={{ fontSize: 32, margin: 0 }}>rcab</h1>
      <p style={{ fontSize: 16, color: '#404040', marginTop: 8 }}>
        Ride-hailing for tier-2/3 Indian cities. Book a private cab, or share a ride and split the fare.
      </p>
      <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
        <Link href="/book" style={{ ...LINK_STYLE, background: '#111', color: '#fff' }}>
          Book a ride
        </Link>
        <Link href="/signin" style={{ ...LINK_STYLE, border: '1px solid #d4d4d4', color: '#111' }}>
          Sign in
        </Link>
      </div>
    </main>
  );
}
