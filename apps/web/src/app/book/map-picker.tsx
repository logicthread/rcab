'use client';

import { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Place } from '../../lib/booking/types';

// Inline-SVG teardrop pins (no raster icon assets — avoids the Leaflet/bundler
// default-marker breakage and keeps the bundle lean).
function pin(color: string): L.DivIcon {
  return L.divIcon({
    className: 'rcab-pin',
    html: `<svg width="28" height="28" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="${color}" stroke="#fff" stroke-width="1.5" d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/><circle cx="12" cy="9" r="2.5" fill="#fff"/></svg>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
}

const PICKUP_ICON = pin('#16a34a');
const DROPOFF_ICON = pin('#b91c1c');

export interface MapPickerProps {
  pickup: Place | null;
  dropoff: Place | null;
  /** OSRM route geometry coordinates as [lng, lat] (GeoJSON order). */
  routeCoords: [number, number][] | null;
  center: { lat: number; lng: number };
  onMapClick: (lat: number, lng: number) => void;
}

function ClickCapture({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// Recenter / fit the map to the union of whatever points are set.
function FitBounds({ pickup, dropoff }: { pickup: Place | null; dropoff: Place | null }) {
  const map = useMap();
  useEffect(() => {
    const pts: L.LatLngExpression[] = [];
    if (pickup) pts.push([pickup.lat, pickup.lng]);
    if (dropoff) pts.push([dropoff.lat, dropoff.lng]);
    if (pts.length === 1) {
      map.setView(pts[0], 14);
    } else if (pts.length === 2) {
      map.fitBounds(L.latLngBounds(pts), { padding: [48, 48] });
    }
  }, [map, pickup, dropoff]);
  return null;
}

export function MapPicker({ pickup, dropoff, routeCoords, center, onMapClick }: MapPickerProps) {
  // GeoJSON is [lng, lat]; Leaflet wants [lat, lng].
  const line = routeCoords?.map(([lng, lat]) => [lat, lng] as [number, number]);

  return (
    <MapContainer
      center={[center.lat, center.lng]}
      zoom={13}
      scrollWheelZoom
      style={{ height: 340, width: '100%', borderRadius: 8 }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickCapture onMapClick={onMapClick} />
      <FitBounds pickup={pickup} dropoff={dropoff} />
      {pickup && <Marker position={[pickup.lat, pickup.lng]} icon={PICKUP_ICON} />}
      {dropoff && <Marker position={[dropoff.lat, dropoff.lng]} icon={DROPOFF_ICON} />}
      {line && line.length > 1 && (
        <Polyline positions={line} pathOptions={{ color: '#111', weight: 5, opacity: 0.85 }} />
      )}
    </MapContainer>
  );
}
