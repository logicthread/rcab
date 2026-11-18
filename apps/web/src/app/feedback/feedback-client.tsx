'use client';

import { useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { withAuth } from '../../lib/auth/with-auth';
import { submitFeedback, type FeedbackCategory } from '../../lib/account/api';
import { Button, buttonStyles } from '../../components/ui/button';
import { PageHeader } from '../../components/page-header';

const MAX = 2000;

const CATEGORIES: Array<{ id: FeedbackCategory; label: string }> = [
  { id: 'bug', label: 'Something is broken' },
  { id: 'idea', label: 'Idea' },
  { id: 'compliment', label: 'Compliment' },
  { id: 'other', label: 'Other' },
];

function FeedbackPage() {
  const [category, setCategory] = useState<FeedbackCategory>('idea');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await submitFeedback(category, message.trim());
      setSent(true);
    } catch {
      setError('Could not send your feedback. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <main className="mx-auto max-w-lg px-4 pb-10 pt-5">
        <PageHeader title="Give feedback" />
        <div data-testid="feedback-sent" className="mt-10 text-center">
          <p className="text-2xl font-bold">Thanks, we got it</p>
          <p className="mt-2 text-muted">Your feedback was sent to the rcab team.</p>
          <Link href="/book" className={buttonStyles({ variant: 'accent', size: 'lg' }) + ' mt-6'}>
            Back to booking
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg px-4 pb-10 pt-5">
      <PageHeader title="Give feedback" />
      <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-5">
        <fieldset>
          <legend className="text-sm font-semibold">What is it about?</legend>
          <div role="radiogroup" aria-label="Feedback type" className="mt-2 flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={category === c.id}
                data-testid={`feedback-${c.id}`}
                onClick={() => setCategory(c.id)}
                className={clsx(
                  'min-h-tap rounded-full border px-4 text-sm font-medium transition-colors',
                  category === c.id
                    ? 'border-ink bg-ink text-on-ink'
                    : 'border-line-strong bg-surface hover:bg-paper',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="feedback-message" className="text-sm font-semibold">
            Tell us more
          </label>
          <textarea
            id="feedback-message"
            data-testid="feedback-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={MAX}
            rows={6}
            placeholder="What happened, or what would make rcab better?"
            className="mt-2 w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-base"
          />
          <div className="mt-1 text-right text-xs text-muted">
            {message.length}/{MAX}
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-control bg-stop-wash px-3 py-2 text-sm font-medium text-stop"
          >
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="accent"
          size="lg"
          block
          loading={busy}
          disabled={!message.trim()}
          data-testid="feedback-submit"
        >
          {busy ? 'Sending…' : 'Send feedback'}
        </Button>
      </form>
    </main>
  );
}

export default withAuth(FeedbackPage);
