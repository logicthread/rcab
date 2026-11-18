import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useAuthStore } from '../../lib/auth/store';
import type { RideHistoryItem } from '../../lib/booking/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('../../lib/booking/api', () => ({ fetchRideHistory: vi.fn() }));

import HistoryClient from './history-client';
import * as api from '../../lib/booking/api';

const fetchRideHistory = vi.mocked(api.fetchRideHistory);

function ride(over: Partial<RideHistoryItem> = {}): RideHistoryItem {
  return {
    rideId: 'r1',
    status: 'completed',
    type: 'normal',
    fare: { amount: 18500, currency: 'INR' },
    origin: { lat: 26.1445, lng: 91.7362 },
    dropoff: { lat: 26.1758, lng: 91.7898 },
    scheduledFor: null,
    createdAt: '2026-11-17T08:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: { id: 'u1', role: 'client', phone_e164: '+911234567890' },
    jwt: 'jwt',
    jwtExpiresAt: null,
    signedOut: false,
  });
});

describe('ride history page', () => {
  it('lists rides with fare and a readable status', async () => {
    fetchRideHistory.mockResolvedValue([ride(), ride({ rideId: 'r2', status: 'cancelled' })]);
    render(<HistoryClient />);
    const items = await screen.findAllByTestId('history-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('₹185.00');
    expect(items[0]).toHaveTextContent('Completed');
    expect(items[1]).toHaveTextContent('Cancelled');
  });

  it('shows an empty state with a way to book', async () => {
    fetchRideHistory.mockResolvedValue([]);
    render(<HistoryClient />);
    expect(await screen.findByTestId('history-empty')).toHaveTextContent('No rides yet');
    expect(screen.getByRole('link', { name: 'Book a ride' })).toHaveAttribute('href', '/book');
  });

  it('explains a failure and retries', async () => {
    fetchRideHistory.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([ride()]);
    render(<HistoryClient />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your rides');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByTestId('history-item')).toHaveLength(1));
  });
});
