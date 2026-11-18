'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { withAuth } from '../../lib/auth/with-auth';
import { fetchProfile, updateProfileName, type Profile } from '../../lib/account/api';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { PageHeader } from '../../components/page-header';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; profile: Profile };

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-3 last:border-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="break-all text-right font-medium">{value || '—'}</dd>
    </div>
  );
}

function ProfilePage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    fetchProfile().then(
      (profile) => {
        if (cancelled) return;
        setName(profile.displayName ?? '');
        setLoad({ status: 'ready', profile });
      },
      () => !cancelled && setLoad({ status: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    const next = name.trim();
    if (!next || saving) return;
    setSaving(true);
    try {
      const profile = await updateProfileName(next);
      setLoad({ status: 'ready', profile });
      setName(profile.displayName ?? '');
      toast.success('Profile saved');
    } catch {
      toast.error('Could not save your profile. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-lg px-4 pb-10 pt-5">
      <PageHeader title="Profile" />

      {load.status === 'loading' && (
        <p role="status" className="mt-6 flex items-center gap-2 text-muted">
          <Spinner /> Loading your profile…
        </p>
      )}

      {load.status === 'error' && (
        <div role="alert" className="mt-6 rounded-panel border border-stop/30 bg-stop-wash p-4">
          <p className="text-stop">Could not load your profile.</p>
          <Button variant="secondary" className="mt-3" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}

      {load.status === 'ready' && (
        <>
          <form onSubmit={onSave} className="mt-6 flex flex-col gap-2">
            <label htmlFor="profile-name" className="text-sm font-semibold">
              Name
            </label>
            <input
              id="profile-name"
              data-testid="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Your name"
              className="min-h-tap rounded-control border border-line-strong bg-surface px-3 text-base"
            />
            <Button
              type="submit"
              variant="accent"
              size="lg"
              block
              className="mt-2"
              loading={saving}
              disabled={!name.trim() || name.trim() === (load.profile.displayName ?? '')}
              data-testid="profile-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </form>

          <dl
            className="mt-6 rounded-panel border border-line bg-surface px-4 shadow-lift"
            data-testid="profile-details"
          >
            <Row label="Email" value={load.profile.email} />
            <Row label="Phone" value={load.profile.phone} />
            <Row
              label="Member since"
              value={new Date(load.profile.memberSince).toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
              })}
            />
          </dl>
          <p className="mt-2 text-sm text-muted">
            Email and phone come from your sign-in and can’t be changed here.
          </p>
        </>
      )}
    </main>
  );
}

export default withAuth(ProfilePage);
