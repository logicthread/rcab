'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from './store';

export function withAuth<P extends object>(
  Component: React.ComponentType<P>,
): React.ComponentType<P> {
  return function ProtectedRoute(props: P) {
    const router = useRouter();
    const { user, jwt, silentRefresh } = useAuthStore();

    useEffect(() => {
      if (!jwt) {
        silentRefresh().then(() => {
          if (!useAuthStore.getState().jwt) {
            router.replace('/signin');
          }
        });
      }
    }, [jwt, router, silentRefresh]);

    if (!user) return null;
    return <Component {...props} />;
  };
}
