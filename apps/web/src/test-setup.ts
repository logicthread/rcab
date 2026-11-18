import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { FEATURES } from './config/features';

// Tests run with the shipped switches (shared rides off); a suite that exercises the
// shared-ride UI turns the flag on itself.
FEATURES.sharedRides = false;

// jsdom has no matchMedia; vaul (drawer) and next-themes read it.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

afterEach(() => {
  cleanup();
});
