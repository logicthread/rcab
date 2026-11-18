import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { FEATURES } from './config/features';

// The shipped build hides shared rides; the existing suites exercise them, so
// tests run with the feature on and opt out explicitly where they test "off".
FEATURES.sharedRides = true;

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
