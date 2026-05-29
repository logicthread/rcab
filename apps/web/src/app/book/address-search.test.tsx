import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddressSearch } from './address-search';

const searchPlaces = vi.fn();

vi.mock('../../lib/geo/nominatim', () => ({
  MIN_QUERY_LENGTH: 3,
  searchPlaces: (...args: unknown[]) => searchPlaces(...args),
}));

describe('AddressSearch', () => {
  beforeEach(() => {
    searchPlaces.mockReset();
  });

  it('does not query Nominatim for inputs shorter than the minimum length', async () => {
    render(
      <AddressSearch label="Pickup" value={null} onSelect={() => undefined} testId="pickup" />,
    );
    await userEvent.type(screen.getByTestId('pickup'), 'ab');
    await new Promise((r) => setTimeout(r, 450));
    expect(searchPlaces).not.toHaveBeenCalled();
  });

  it('debounces, renders suggestions, and fires onSelect with the chosen place', async () => {
    searchPlaces.mockResolvedValue([
      { label: 'Paltan Bazaar, Guwahati', lat: 26.175, lng: 91.751 },
      { label: 'Zoo Road, Guwahati', lat: 26.167, lng: 91.7898 },
    ]);
    const onSelect = vi.fn();
    render(<AddressSearch label="Pickup" value={null} onSelect={onSelect} testId="pickup" />);

    await userEvent.type(screen.getByTestId('pickup'), 'Guwahati');
    const option = await screen.findByText('Paltan Bazaar, Guwahati');
    expect(searchPlaces).toHaveBeenCalled();

    await userEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith({
      lat: 26.175,
      lng: 91.751,
      label: 'Paltan Bazaar, Guwahati',
    });
  });

  it('calls onFocus so the parent can mark this field active', async () => {
    const onFocus = vi.fn();
    render(
      <AddressSearch
        label="Dropoff"
        value={null}
        onSelect={() => undefined}
        onFocus={onFocus}
        testId="dropoff"
      />,
    );
    await userEvent.click(screen.getByTestId('dropoff'));
    expect(onFocus).toHaveBeenCalled();
  });
});
