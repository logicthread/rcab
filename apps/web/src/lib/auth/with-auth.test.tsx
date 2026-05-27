import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { withAuth } from './with-auth';
import { useAuthStore } from './store';

const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

function DummyComponent() {
  return <div>Protected content</div>;
}

const ProtectedDummy = withAuth(DummyComponent);

describe('withAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: null,
      jwt: null,
      silentRefresh: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('renders the wrapped component when user is present', () => {
    useAuthStore.setState({
      user: { id: 'u1', role: 'client', phone_e164: '+12025551234' },
      jwt: 'valid-jwt',
    });
    render(<ProtectedDummy />);
    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });

  it('renders nothing initially when no user', () => {
    render(<ProtectedDummy />);
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('redirects to /signin after silentRefresh when still no jwt', async () => {
    const mockSilentRefresh = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ silentRefresh: mockSilentRefresh });

    render(<ProtectedDummy />);

    await waitFor(() => {
      expect(mockSilentRefresh).toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith('/signin');
    });
  });

  it('does not redirect when jwt is present after silentRefresh', async () => {
    const mockSilentRefresh = vi.fn().mockImplementation(async () => {
      useAuthStore.setState({
        jwt: 'refreshed-jwt',
        user: { id: 'u1', role: 'client', phone_e164: '+1' },
      });
    });
    useAuthStore.setState({ silentRefresh: mockSilentRefresh });

    render(<ProtectedDummy />);

    await waitFor(() => {
      expect(mockSilentRefresh).toHaveBeenCalled();
    });

    expect(mockReplace).not.toHaveBeenCalledWith('/signin');
  });
});
