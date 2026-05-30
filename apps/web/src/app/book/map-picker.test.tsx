import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import type { Place } from '../../lib/booking/types';

// react-leaflet renders a real Leaflet map (needs layout + canvas) which jsdom
// can't provide, so we stub the primitives and assert MapPicker wires them up.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: ReactNode }) => <div data-testid="map">{children}</div>,
  TileLayer: () => <div data-testid="tile" />,
  Marker: ({ position }: { position: [number, number] }) => (
    <div data-testid="marker" data-pos={JSON.stringify(position)} />
  ),
  Polyline: ({ positions }: { positions: [number, number][] }) => (
    <div data-testid="route-line" data-points={positions.length} />
  ),
  useMap: () => ({ setView: vi.fn(), fitBounds: vi.fn() }),
  useMapEvents: () => null,
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn(() => ({})),
    latLngBounds: vi.fn(() => ({})),
  },
}));

vi.mock('leaflet/dist/leaflet.css', () => ({}));

import { MapPicker } from './map-picker';

const PICKUP: Place = { lat: 26.175, lng: 91.751, label: 'Paltan Bazaar' };
const DROPOFF: Place = { lat: 26.167, lng: 91.7898, label: 'Zoo Road' };
const CENTER = { lat: 26.1445, lng: 91.7362 };
// OSRM geometry is [lng, lat].
const ROUTE: [number, number][] = [
  [91.751, 26.175],
  [91.77, 26.171],
  [91.7898, 26.167],
];

describe('MapPicker', () => {
  it('renders a route Polyline when geometry coordinates are present', () => {
    render(
      <MapPicker
        pickup={PICKUP}
        dropoff={DROPOFF}
        routeCoords={ROUTE}
        center={CENTER}
        onMapClick={() => undefined}
      />,
    );
    const line = screen.getByTestId('route-line');
    expect(line).toBeInTheDocument();
    expect(line).toHaveAttribute('data-points', '3');
  });

  it('renders no route line when there is no geometry yet', () => {
    render(
      <MapPicker
        pickup={PICKUP}
        dropoff={null}
        routeCoords={null}
        center={CENTER}
        onMapClick={() => undefined}
      />,
    );
    expect(screen.queryByTestId('route-line')).not.toBeInTheDocument();
  });

  it('renders a marker for each endpoint that is set', () => {
    render(
      <MapPicker
        pickup={PICKUP}
        dropoff={DROPOFF}
        routeCoords={null}
        center={CENTER}
        onMapClick={() => undefined}
      />,
    );
    const markers = screen.getAllByTestId('marker');
    expect(markers).toHaveLength(2);
    // Leaflet order is [lat, lng].
    expect(markers[0]).toHaveAttribute('data-pos', JSON.stringify([PICKUP.lat, PICKUP.lng]));
  });

  it('renders a third marker at the live driver position (RCAB-E4.S7)', () => {
    render(
      <MapPicker
        pickup={PICKUP}
        dropoff={DROPOFF}
        routeCoords={null}
        center={CENTER}
        onMapClick={() => undefined}
        driver={{ lat: 26.16, lng: 91.76 }}
      />,
    );
    const markers = screen.getAllByTestId('marker');
    expect(markers).toHaveLength(3);
    expect(markers[2]).toHaveAttribute('data-pos', JSON.stringify([26.16, 91.76]));
  });
});
