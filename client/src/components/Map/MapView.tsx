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
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <MapContainer
        center={[-34.6037, -58.3816]}
        zoom={13}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          subdomains="abcd"
          maxZoom={20}
        />
        <DrawControls onPolygonChange={handlePolygonChange} />
        <GridOverlay cells={cells} cellCount={cellCount} />
        <MapInstanceCapture onReady={setMapInstance} />
      </MapContainer>

      {/* Logo chip */}
      <div style={{
        position: 'absolute',
        top: '16px',
        left: '16px',
        zIndex: 1000,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        background: 'rgba(22,25,32,0.70)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '10px',
        padding: '8px 14px',
        fontFamily: 'var(--font-ui)',
        fontWeight: 600,
        fontSize: '13px',
        color: 'var(--text-primary)',
        letterSpacing: '0.06em',
        userSelect: 'none',
        pointerEvents: 'none',
      }}>
        MAPS <span style={{ color: 'var(--accent)' }}>·</span> SCRAPER
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
          animation: 'pulse 2.4s ease-in-out infinite',
        }}>
          <div style={{
            width: '100px',
            height: '68px',
            border: '2px dashed var(--accent)',
            borderRadius: '4px',
            margin: '0 auto',
          }} />
          <div style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '13px',
            color: 'var(--text-muted)',
            marginTop: '10px',
          }}>
            Dibujá un área para comenzar
          </div>
        </div>
      )}
    </div>
  );
}
