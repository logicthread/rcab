'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from './store';

export function withAuth<P extends object>(
  Component: React.ComponentType<P>,
): React.ComponentType<P> {
  return function ProtectedRoute(props: P) {
    const router = useRouter();
    const { user, jwt, signedOut, silentRefresh } = useAuthStore();

    useEffect(() => {
      if (jwt) return;
      // Explicit sign-out: go to sign-in, never refresh (the cookie may still be
      // live until the logout request lands, which would silently log back in).
      if (signedOut) {
        router.replace('/signin');
        return;
      }
      silentRefresh().then(() => {
        if (!useAuthStore.getState().jwt) {
          router.replace('/signin');
        }
      });
    }, [jwt, signedOut, router, silentRefresh]);

    if (!user) return null;
    return <Component {...props} />;
  };
}
