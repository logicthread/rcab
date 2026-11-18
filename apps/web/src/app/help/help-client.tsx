'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { withAuth } from '../../lib/auth/with-auth';
import {
  fetchSupportMessages,
  sendSupportMessage,
  type SupportMessage,
} from '../../lib/account/api';
import { Button } from '../../components/ui/button';
import { PageHeader } from '../../components/page-header';

const POLL_MS = 5_000;
const MAX = 2000;

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function HelpPage() {
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const rows = await fetchSupportMessages();
      setMessages(rows);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  // Initial load, then poll so a support reply appears without a refresh.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const count = messages?.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [count]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError('');
    try {
      const created = await sendSupportMessage(body);
      setMessages((prev) => [...(prev ?? []), ...created]);
      setDraft('');
    } catch {
      setSendError('Could not send your message. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col px-4 pt-5">
      <PageHeader title="Contact help" />

      <section
        aria-label="Conversation"
        aria-live="polite"
        data-testid="help-thread"
        className="mt-4 flex flex-1 flex-col gap-2 pb-4"
      >
        {messages === null && !loadError && (
          <p role="status" className="text-muted">
            Loading your conversation…
          </p>
        )}
        {loadError && messages === null && (
          <div role="alert" className="rounded-panel border border-stop/30 bg-stop-wash p-4">
            <p className="text-stop">Could not load the conversation.</p>
            <Button variant="secondary" className="mt-3" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {messages !== null && messages.length === 0 && (
          <div data-testid="help-empty" className="mt-8 text-center">
            <p className="text-lg font-semibold">How can we help?</p>
            <p className="mt-1 text-muted">
              Describe the problem and our team will reply here. Include the ride time if it is
              about a trip.
            </p>
          </div>
        )}
        {messages?.map((m) => (
          <div
            key={m.id}
            data-testid={`msg-${m.sender}`}
            className={clsx('flex flex-col', m.sender === 'user' ? 'items-end' : 'items-start')}
          >
            <div
              className={clsx(
                'max-w-[85%] whitespace-pre-wrap break-words rounded-panel px-3.5 py-2.5',
                m.sender === 'user'
                  ? 'rounded-br-md bg-ink text-on-ink'
                  : 'rounded-bl-md border border-line bg-surface',
              )}
            >
              {m.body}
            </div>
            <span className="mt-0.5 px-1 text-xs text-muted">
              {m.sender === 'support' ? 'rcab support · ' : ''}
              {timeOf(m.createdAt)}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </section>

      <form
        onSubmit={onSend}
        className="sticky bottom-0 -mx-4 border-t border-line bg-paper px-4 pb-4 pt-3"
      >
        {sendError && (
          <p role="alert" className="mb-2 text-sm font-medium text-stop">
            {sendError}
          </p>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor="help-message" className="sr-only">
            Message
          </label>
          <textarea
            id="help-message"
            data-testid="help-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX}
            rows={2}
            placeholder="Type your message"
            className="min-h-tap flex-1 resize-none rounded-control border border-line-strong bg-surface px-3 py-2 text-base"
          />
          <Button
            type="submit"
            variant="accent"
            loading={sending}
            disabled={!draft.trim()}
            data-testid="help-send"
          >
            Send
          </Button>
        </div>
      </form>
    </main>
  );
}

export default withAuth(HelpPage);
