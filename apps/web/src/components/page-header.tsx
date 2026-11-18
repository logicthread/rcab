import Link from 'next/link';
import { buttonStyles } from './ui/button';

/** Back arrow + page title, shared by the menu destinations (history, profile, feedback, help). */
export function PageHeader({ title }: { title: string }) {
  return (
    <header className="flex items-center gap-2">
      <Link
        href="/book"
        aria-label="Back to booking"
        className={buttonStyles({ variant: 'ghost' }) + ' -ml-2 px-3'}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M15 5l-7 7 7 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Link>
      <h1 className="text-2xl font-bold">{title}</h1>
    </header>
  );
}
