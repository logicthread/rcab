'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { clsx } from 'clsx';

const OPTIONS = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const;

/** System / Light / Dark. The stored theme is only known on the client, so render unselected until mounted. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? 'system') : null;

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex gap-1 rounded-panel border border-line bg-paper p-1"
    >
      {OPTIONS.map((opt) => {
        const selected = current === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`theme-${opt.id}`}
            onClick={() => setTheme(opt.id)}
            className={clsx(
              'min-h-tap flex-1 rounded-[12px] px-2 text-sm font-semibold transition-colors duration-150',
              selected ? 'bg-ink text-on-ink' : 'text-ink hover:bg-surface',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
