import type { Config } from 'tailwindcss';

// Design tokens live as CSS variables in src/app/globals.css (space-separated
// RGB so Tailwind opacity modifiers work). Names are the vocabulary: ink is the
// text/primary surface, amber is the one accent, everything else is quiet.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: token('ink'), soft: token('ink-soft') },
        'on-ink': token('on-ink'),
        'amber-ink': token('amber-ink'),
        paper: token('paper'),
        surface: token('surface'),
        line: { DEFAULT: token('line'), strong: token('line-strong') },
        muted: token('muted'),
        amber: { DEFAULT: token('amber'), deep: token('amber-deep'), wash: token('amber-wash') },
        go: { DEFAULT: token('go'), wash: token('go-wash') },
        stop: { DEFAULT: token('stop'), wash: token('stop-wash') },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        control: '10px',
        panel: '16px',
      },
      boxShadow: {
        sheet: '0 -8px 32px -12px rgb(20 22 26 / 0.22)',
        lift: '0 1px 2px rgb(20 22 26 / 0.06), 0 6px 16px -8px rgb(20 22 26 / 0.18)',
      },
      minHeight: { tap: '44px' },
    },
  },
  plugins: [],
};

export default config;
