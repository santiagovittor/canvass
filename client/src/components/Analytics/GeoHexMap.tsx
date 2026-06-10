import { useMemo, useState } from 'react';
import { MapContainer, TileLayer, Polygon, Tooltip } from 'react-leaflet';
import { computeHexbins } from '../../lib/hexbin';
import type { GeoPoint } from '../../lib/analyticsApi';
import type { LatLngBoundsExpression } from 'leaflet';

type Metric = 'density' | 'yield' | 'contacted';

interface GeoHexMapProps {
  points: GeoPoint[];
}

const METRICS: { key: Metric; label: string }[] = [
  { key: 'density', label: 'Density' },
  { key: 'yield', label: 'Email yield' },
  { key: 'contacted', label: 'Contacted' },
];

const ACCENT = '#E8930A';

export function GeoHexMap({ points }: GeoHexMapProps) {
  const [metric, setMetric] = useState<Metric>('density');

  const bins = useMemo(() => computeHexbins(points, 400), [points]);
  const maxCount = useMemo(() => bins.reduce((m, b) => Math.max(m, b.count), 0), [bins]);

  const bounds = useMemo<LatLngBoundsExpression | null>(() => {
    if (points.length === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return [[minLat, minLng], [maxLat, maxLng]];
  }, [points]);

  function binValue(bin: { count: number; withEmail: number; contacted: number }): number {
    if (metric === 'density') return maxCount > 0 ? bin.count / maxCount : 0;
    if (metric === 'yield') return bin.count > 0 ? bin.withEmail / bin.count : 0;
    return bin.withEmail > 0 ? bin.contacted / bin.withEmail : 0;
  }

  return (
    <div className="an-card an-card--map">
      <div className="an-map-header">
        <h2 className="an-card-title">Geographic coverage</h2>
        <div className="an-map-toggle" role="group" aria-label="Hexbin color metric">
          {METRICS.map(m => (
            <button
              key={m.key}
              className={`an-map-toggle-btn${metric === m.key ? ' an-map-toggle-btn--active' : ''}`}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="an-map-body">
        {points.length === 0 ? (
          <div className="an-empty">No geocoded leads yet. Run a scrape and the coverage map fills in.</div>
        ) : (
          <MapContainer
            bounds={bounds ?? undefined}
            boundsOptions={{ padding: [24, 24] }}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            />
            {bins.map((bin, i) => {
              const v = binValue(bin);
              // density gets a perceptual lift so sparse hexes stay visible
              const t = metric === 'density' ? Math.pow(v, 0.55) : v;
              const yieldPct = bin.count > 0 ? Math.round((bin.withEmail / bin.count) * 100) : 0;
              const contactedPct = bin.withEmail > 0 ? Math.round((bin.contacted / bin.withEmail) * 100) : 0;
              return (
                <Polygon
                  key={`${metric}-${i}`}
                  positions={bin.corners}
                  pathOptions={{
                    color: ACCENT,
                    weight: 0.5,
                    opacity: 0.5,
                    fillColor: ACCENT,
                    fillOpacity: 0.08 + t * 0.62,
                  }}
                >
                  <Tooltip direction="top" offset={[0, -8]} sticky className="an-hex-tooltip">
                    <span className="mono">{bin.count}</span> leads · <span className="mono">{yieldPct}%</span> email · <span className="mono">{contactedPct}%</span> contacted
                  </Tooltip>
                </Polygon>
              );
            })}
          </MapContainer>
        )}
      </div>
    </div>
  );
}
