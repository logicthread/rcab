import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '../../lib/auth/store';

const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock('firebase/auth', () => ({
  signInWithPhoneNumber: vi.fn(),
  RecaptchaVerifier: vi.fn().mockImplementation(() => ({ clear: vi.fn() })),
}));

vi.mock('../../lib/auth/firebase', () => ({
  firebaseAuth: {},
}));

import { signInWithPhoneNumber } from 'firebase/auth';
import SignInPage from './sign-in-client';

describe('SignInPage', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, jwt: null });
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to /book when already authenticated', () => {
    useAuthStore.setState({
      user: { id: 'uid', role: 'client', phone_e164: '+12025551234' },
      jwt: 'some-jwt',
    });
    render(<SignInPage />);
    expect(mockReplace).toHaveBeenCalledWith('/book');
  });

  it('calls signInWithPhoneNumber with the entered phone number', async () => {
    const user = userEvent.setup();
    vi.mocked(signInWithPhoneNumber).mockResolvedValue({ confirm: vi.fn() } as never);

    render(<SignInPage />);
    await user.type(screen.getByLabelText(/phone number/i), '+12025551234');
    await user.click(screen.getByRole('button', { name: /send otp/i }));

    await waitFor(() => {
      expect(signInWithPhoneNumber).toHaveBeenCalledWith(
        expect.anything(),
        '+12025551234',
        expect.anything(),
      );
    });
  });

  it('shows OTP input after phone submit succeeds', async () => {
    const user = userEvent.setup();
    vi.mocked(signInWithPhoneNumber).mockResolvedValue({ confirm: vi.fn() } as never);

    render(<SignInPage />);
    await user.type(screen.getByLabelText(/phone number/i), '+12025551234');
    await user.click(screen.getByRole('button', { name: /send otp/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/6-digit otp/i)).toBeInTheDocument();
    });
  });

  it('calls firebase-exchange, stores JWT in auth state, and redirects on correct OTP', async () => {
    const ue = userEvent.setup();
    const mockConfirm = vi.fn().mockResolvedValue({
      user: { getIdToken: vi.fn().mockResolvedValue('firebase-id-token') },
    });
    vi.mocked(signInWithPhoneNumber).mockResolvedValue({ confirm: mockConfirm } as never);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'rcab-jwt',
          user: { id: 'uid', role: 'client', phone_e164: '+12025551234' },
        }),
    } as Response);

    render(<SignInPage />);
    await ue.type(screen.getByLabelText(/phone number/i), '+12025551234');
    await ue.click(screen.getByRole('button', { name: /send otp/i }));
    await waitFor(() => screen.getByLabelText(/6-digit otp/i));
    await ue.type(screen.getByLabelText(/6-digit otp/i), '123456');
    await ue.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/auth/firebase-exchange'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id_token: 'firebase-id-token' }),
        }),
      );
      expect(useAuthStore.getState().jwt).toBe('rcab-jwt');
      expect(mockReplace).toHaveBeenCalledWith('/book');
    });
  });

  it('shows an error on incorrect OTP without redirecting', async () => {
    const ue = userEvent.setup();
    const mockConfirm = vi.fn().mockRejectedValue(new Error('auth/invalid-verification-code'));
    vi.mocked(signInWithPhoneNumber).mockResolvedValue({ confirm: mockConfirm } as never);

    render(<SignInPage />);
    await ue.type(screen.getByLabelText(/phone number/i), '+12025551234');
    await ue.click(screen.getByRole('button', { name: /send otp/i }));
    await waitFor(() => screen.getByLabelText(/6-digit otp/i));
    await ue.type(screen.getByLabelText(/6-digit otp/i), '999999');
    await ue.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('auth/invalid-verification-code');
    });
    expect(mockReplace).not.toHaveBeenCalledWith('/book');
  });
});
