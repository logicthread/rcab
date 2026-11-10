'use client';

import { useRef, useState } from 'react';
import {
  signInWithPhoneNumber,
  RecaptchaVerifier,
  type ConfirmationResult,
} from 'firebase/auth';
import { getFirebaseAuth } from '../../lib/auth/firebase';

/**
 * Phone OTP sign-in (Firebase). Rendered ONLY when the API's `GET /v1/auth/config`
 * lists 'phone' (policy `auth.enabledMethods`); it is disabled until launch
 * (RCAB-E8.S15) and will be replaced by the pre-launch OTP provider. The parent
 * owns the token exchange: this component's job ends at a Firebase ID token.
 */
export default function PhoneSignIn({
  onIdToken,
  onError,
  busy,
}: {
  onIdToken: (firebaseIdToken: string) => Promise<void>;
  onError: (message: string) => void;
  busy: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);

  const confirmationRef = useRef<ConfirmationResult | null>(null);
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);
  const recaptchaContainerRef = useRef<HTMLDivElement>(null);

  // Lazy-init the invisible reCAPTCHA on first phone submit. Initializing
  // in a useEffect interacts badly with React Strict Mode (the cleanup
  // pass nulls the DOM node the recaptcha library still holds a reference
  // to, and the next render throws `Cannot read properties of null
  // (reading 'style')` from inside grecaptcha).
  function getRecaptcha(): RecaptchaVerifier {
    if (recaptchaRef.current) return recaptchaRef.current;
    if (!recaptchaContainerRef.current) {
      throw new Error('reCAPTCHA container not mounted');
    }
    const verifier = new RecaptchaVerifier(getFirebaseAuth(), recaptchaContainerRef.current, {
      size: 'invisible',
    });
    recaptchaRef.current = verifier;
    return verifier;
  }

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    onError('');
    setLoading(true);
    try {
      const confirmation = await signInWithPhoneNumber(getFirebaseAuth(), phone, getRecaptcha());
      confirmationRef.current = confirmation;
      setStep('otp');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    onError('');
    setLoading(true);
    let firebaseIdToken: string;
    try {
      const result = await confirmationRef.current!.confirm(otp);
      firebaseIdToken = await result.user.getIdToken();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Invalid OTP');
      setLoading(false);
      return;
    }
    try {
      await onIdToken(firebaseIdToken);
    } finally {
      setLoading(false);
    }
  }

  const disabled = loading || busy;

  return (
    <section aria-label="Phone sign-in">
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
          <button type="submit" disabled={disabled}>
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
          <button type="submit" disabled={disabled}>
            {loading ? 'Verifying…' : 'Verify'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('phone');
              onError('');
            }}
          >
            ← Back
          </button>
        </form>
      )}

      {/* Invisible reCAPTCHA anchor */}
      <div ref={recaptchaContainerRef} />
    </section>
  );
}
