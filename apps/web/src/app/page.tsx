import Link from 'next/link';
import { buttonStyles } from '../components/ui/button';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-between px-4 pb-8 pt-12">
      <div>
        <h1 className="inline-flex items-center rounded-full bg-amber px-3 py-1 text-sm font-bold text-amber-ink">
          rcab
        </h1>
        <p className="mt-6 text-[44px] font-bold leading-[1.05] tracking-tight">
          Your cab, at the corner in minutes.
        </p>
        <p className="mt-4 max-w-[34ch] text-lg text-muted">
          Book a bike, auto, cab or SUV and follow your driver live.
        </p>
      </div>
      <div className="mt-10 flex flex-col gap-3">
        <Link href="/book" className={buttonStyles({ variant: 'accent', size: 'lg', block: true })}>
          Book a ride
        </Link>
        <Link
          href="/signin"
          className={buttonStyles({ variant: 'secondary', size: 'lg', block: true })}
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
