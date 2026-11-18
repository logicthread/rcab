'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Drawer } from 'vaul';
import { Button } from './ui/button';
import { ThemeToggle } from './theme-toggle';

interface Props {
  /** Shown at the top of the menu ("who am I signed in as"). */
  account: string | null | undefined;
  onSignOut: () => void;
}

const ITEM =
  'flex min-h-[52px] items-center rounded-control px-3 text-base font-medium text-ink transition-colors hover:bg-paper';

/** Left-hand side menu: ride history, feedback, help, theme, sign out. */
export function MenuDrawer({ account, onSignOut }: Props) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Drawer.Root open={open} onOpenChange={setOpen} direction="left">
      <Drawer.Trigger asChild>
        <Button
          variant="ghost"
          size="md"
          aria-label="Open menu"
          data-testid="menu-open"
          className="-ml-2 px-3"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 7h16M4 12h16M4 17h16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </Button>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[1100] bg-black/50" />
        <Drawer.Content
          data-testid="menu-drawer"
          className="fixed bottom-0 left-0 top-0 z-[1200] flex w-[min(320px,86vw)] flex-col bg-surface p-4 shadow-sheet outline-none"
        >
          <Drawer.Title className="text-xl font-bold">Menu</Drawer.Title>
          <Drawer.Description className="mt-0.5 truncate text-sm text-muted">
            {account ? `Signed in as ${account}` : 'Your account'}
          </Drawer.Description>

          <nav aria-label="Account" className="mt-5 flex flex-col gap-1">
            <Link href="/profile" className={ITEM} onClick={close}>
              Profile
            </Link>
            <Link href="/history" className={ITEM} onClick={close}>
              Ride history
            </Link>
            <Link href="/feedback" className={ITEM} onClick={close}>
              Give feedback
            </Link>
            <Link href="/help" className={ITEM} onClick={close}>
              Contact help
            </Link>
          </nav>

          <section className="mt-6" aria-label="Appearance">
            <div className="mb-2 px-1 text-sm font-semibold text-muted">Theme</div>
            <ThemeToggle />
          </section>

          <div className="mt-auto pt-6">
            <Button
              variant="danger"
              size="lg"
              block
              onClick={() => {
                close();
                onSignOut();
              }}
            >
              Sign out
            </Button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
