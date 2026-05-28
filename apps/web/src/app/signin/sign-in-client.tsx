'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  signInWithPhoneNumber,
  RecaptchaVerifier,
  type ConfirmationResult,
} from 'firebase/auth';
import { firebaseAuth } from '../../lib/auth/firebase';
import { useAuthStore, type AuthUser } from '../../lib/auth/store';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function SignInPage() {
  const router = useRouter();
  const { user, setAuth } = useAuthStore();

  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const confirmationRef = useRef<ConfirmationResult | null>(null);
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);
  const recaptchaContainerRef = useRef<HTMLDivElement>(null);

  // Already authenticated — skip straight to /book
  useEffect(() => {
    if (user) router.replace('/book');
  }, [user, router]);

  // Mount invisible reCAPTCHA
  useEffect(() => {
    if (!recaptchaContainerRef.current) return;
    const verifier = new RecaptchaVerifier(firebaseAuth, recaptchaContainerRef.current, {
      size: 'invisible',
    });
    recaptchaRef.current = verifier;
    return () => { verifier.clear(); };
  }, []);

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const confirmation = await signInWithPhoneNumber(
        firebaseAuth,
        phone,
        recaptchaRef.current!,
      );
      confirmationRef.current = confirmation;
      setStep('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await confirmationRef.current!.confirm(otp);
      const firebaseIdToken = await result.user.getIdToken();

      const res = await fetch(`${API_BASE}/v1/auth/firebase-exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id_token: firebaseIdToken }),
      });

      if (!res.ok) {
        throw new Error('Authentication failed');
      }

      const data = (await res.json()) as {
        access_token: string;
        user: AuthUser;
      };

      setAuth(data.user, data.access_token);
      router.replace('/book');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid OTP');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1>Sign in</h1>

      {step === 'phone' && (
        <form onSubmit={handlePhoneSubmit}>
          <label htmlFor="phone">Phone number (E.164)</label>
          <input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91XXXXXXXXXX"
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Sending…' : 'Send OTP'}
          </button>
        </form>
      )}

      {step === 'otp' && (
        <form onSubmit={handleOtpSubmit}>
          <label htmlFor="otp">Enter 6-digit OTP</label>
          <input
            id="otp"
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Verifying…' : 'Verify'}
          </button>
          <button type="button" onClick={() => { setStep('phone'); setError(''); }}>
            ← Back
          </button>
        </form>
      )}

      {error && <p role="alert">{error}</p>}

      {/* Invisible reCAPTCHA anchor */}
      <div ref={recaptchaContainerRef} />
    </main>
  );
}
