import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useAuthStore } from '../lib/auth/store';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../lib/account/api', () => ({
  fetchProfile: vi.fn(),
  updateProfileName: vi.fn(),
  submitFeedback: vi.fn(),
  fetchSupportMessages: vi.fn(),
  sendSupportMessage: vi.fn(),
}));

import FeedbackClient from './feedback/feedback-client';
import HelpClient from './help/help-client';
import ProfileClient from './profile/profile-client';
import * as api from '../lib/account/api';

const m = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: { id: 'u1', role: 'client', phone_e164: '+911234567890' },
    jwt: 'jwt',
    jwtExpiresAt: null,
    signedOut: false,
  });
});

describe('feedback form', () => {
  it('cannot be sent empty, then sends the chosen category and text', async () => {
    m.submitFeedback.mockResolvedValue({ id: 'f1' });
    render(<FeedbackClient />);
    expect(screen.getByTestId('feedback-submit')).toBeDisabled();

    fireEvent.click(screen.getByTestId('feedback-bug'));
    fireEvent.change(screen.getByTestId('feedback-message'), { target: { value: '  map froze ' } });
    fireEvent.click(screen.getByTestId('feedback-submit'));

    await waitFor(() => expect(m.submitFeedback).toHaveBeenCalledWith('bug', 'map froze'));
    expect(await screen.findByTestId('feedback-sent')).toHaveTextContent('Thanks');
  });

  it('keeps the text and explains a failed send', async () => {
    m.submitFeedback.mockRejectedValue(new Error('down'));
    render(<FeedbackClient />);
    fireEvent.change(screen.getByTestId('feedback-message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('feedback-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send your feedback');
    expect(screen.getByTestId('feedback-message')).toHaveValue('hello');
  });
});

describe('help chat', () => {
  const msg = (id: string, sender: 'user' | 'support', body: string) => ({
    id,
    sender,
    body,
    createdAt: '2026-11-18T10:00:00.000Z',
  });

  it('shows an empty prompt, then the conversation after sending', async () => {
    m.fetchSupportMessages.mockResolvedValue([]);
    m.sendSupportMessage.mockResolvedValue([
      msg('1', 'user', 'my driver did not show'),
      msg('2', 'support', 'Thanks for reaching out.'),
    ]);
    render(<HelpClient />);
    expect(await screen.findByTestId('help-empty')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('help-input'), {
      target: { value: 'my driver did not show' },
    });
    fireEvent.click(screen.getByTestId('help-send'));

    await waitFor(() =>
      expect(m.sendSupportMessage).toHaveBeenCalledWith('my driver did not show'),
    );
    expect(await screen.findByTestId('msg-support')).toHaveTextContent('Thanks for reaching out.');
    expect(screen.getByTestId('msg-user')).toHaveTextContent('my driver did not show');
    expect(screen.getByTestId('help-input')).toHaveValue('');
  });

  it('renders an existing thread with support replies', async () => {
    m.fetchSupportMessages.mockResolvedValue([
      msg('1', 'user', 'hi'),
      msg('2', 'support', 'hello'),
    ]);
    render(<HelpClient />);
    expect(await screen.findByTestId('msg-support')).toHaveTextContent('rcab support');
  });
});

describe('profile', () => {
  const profile = {
    id: 'u1',
    role: 'client' as const,
    displayName: 'Asha',
    email: 'asha@gmail.com',
    phone: null,
    memberSince: '2026-01-05T00:00:00.000Z',
  };

  it('shows details and saves a changed name', async () => {
    m.fetchProfile.mockResolvedValue(profile);
    m.updateProfileName.mockResolvedValue({ ...profile, displayName: 'Asha K' });
    render(<ProfileClient />);
    const input = await screen.findByTestId('profile-name');
    expect(input).toHaveValue('Asha');
    expect(screen.getByTestId('profile-details')).toHaveTextContent('asha@gmail.com');
    // Unchanged name: nothing to save.
    expect(screen.getByTestId('profile-save')).toBeDisabled();

    fireEvent.change(input, { target: { value: 'Asha K' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(m.updateProfileName).toHaveBeenCalledWith('Asha K'));
  });

  it('explains a load failure', async () => {
    m.fetchProfile.mockRejectedValue(new Error('x'));
    render(<ProfileClient />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your profile');
  });
});
