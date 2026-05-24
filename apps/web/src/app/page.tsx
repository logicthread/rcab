import type { Health } from '@rcab/shared';

const status: Health = { ok: true };

export default function HomePage() {
  return (
    <main>
      <h1>rcab — Phase 0 scaffold</h1>
      <p>Stack status: {status.ok ? 'ok' : 'not ok'}</p>
    </main>
  );
}
