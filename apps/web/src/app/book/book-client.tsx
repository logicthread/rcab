'use client';

import { withAuth } from '../../lib/auth/with-auth';
import { useAuthStore } from '../../lib/auth/store';

function BookPage() {
  const { user, signOut } = useAuthStore();
  return (
    <main>
      <h1>Booking</h1>
      <p>Welcome, {user?.phone_e164}</p>
      <button onClick={signOut}>Sign out</button>
    </main>
  );
}

export default withAuth(BookPage);
