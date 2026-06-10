import { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { DrawControls } from './DrawControls';
import { GridOverlay } from './GridOverlay';
import { GeoSearch } from './GeoSearch';
import type { GridCell } from '../../types';

interface MapViewProps {
  onPolygonChange: (polygon: [number, number][] | null) => void;
  cells: GridCell[];
  cellCount: number;
}

function MapInstanceCapture({ onReady }: { onReady: (map: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
    const timer = setTimeout(() => map.invalidateSize(), 100);
    return () => clearTimeout(timer);
  }, [map, onReady]);
  return null;
}

export function MapView({ onPolygonChange, cells, cellCount }: MapViewProps) {
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const [shapeDrawn, setShapeDrawn] = useState(false);

  const handlePolygonChange = useCallback((p: [number, number][] | null) => {
    setShapeDrawn(p !== null);
    onPolygonChange(p);
  }, [onPolygonChange]);

  return (
    <div className="map-wrapper">
      <MapContainer
        center={[-34.6037, -58.3816]}
        zoom={13}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          subdomains="abcd"
          maxZoom={20}
        />
        <DrawControls onPolygonChange={handlePolygonChange} />
        <GridOverlay cells={cells} cellCount={cellCount} />
        <MapInstanceCapture onReady={setMapInstance} />
      </MapContainer>

      {/* Logo chip */}
      <div className="glass-warm" style={{
        position: 'absolute',
        top: '16px',
        left: '16px',
        zIndex: 1000,
        borderRadius: '8px',
        padding: '7px 12px',
        fontFamily: 'var(--font-ui)',
        fontWeight: 600,
        fontSize: '12px',
        color: 'var(--text-primary)',
        letterSpacing: '0.08em',
        userSelect: 'none',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}>
        <span style={{
          display: 'inline-block',
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: 'var(--accent)',
          flexShrink: 0,
        }} />
        MAPS·SCRAPER
      </div>

      {/* Geocoding search */}
      {mapInstance && <GeoSearch map={mapInstance} />}

      {/* Drawing hint — disappears once a shape is drawn */}
      {!shapeDrawn && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 999,
          pointerEvents: 'none',
          textAlign: 'center',
          animation: 'pulse 2.8s ease-in-out infinite',
        }}>
          <svg width="80" height="60" viewBox="0 0 80 60" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block', margin: '0 auto' }}>
            <path d="M4 18L4 4L18 4" stroke="#E8930A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M62 4L76 4L76 18" stroke="#E8930A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M4 42L4 56L18 56" stroke="#E8930A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M62 56L76 56L76 42" stroke="#E8930A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="40" y1="25" x2="40" y2="35" stroke="#E8930A" strokeWidth="1" strokeOpacity="0.55" strokeLinecap="round"/>
            <line x1="35" y1="30" x2="45" y2="30" stroke="#E8930A" strokeWidth="1" strokeOpacity="0.55" strokeLinecap="round"/>
          </svg>
          <div style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '12px',
            fontWeight: 500,
            color: 'var(--text-muted)',
            marginTop: '12px',
            letterSpacing: '0.04em',
          }}>
            Dibujá un área para comenzar
          </div>
        </div>
      )}
    </div>
  );
}
