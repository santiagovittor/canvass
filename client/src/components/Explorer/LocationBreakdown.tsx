import { useMemo, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker } from 'react-leaflet';
import type { ExplorerBusiness } from '../../types';

interface LocationBreakdownProps {
  rows: ExplorerBusiness[];
  onCityClick?: (city: string) => void;
}

interface CityEntry { city: string; count: number }
interface ProvinceGroup { province: string; total: number; cities: CityEntry[] }

function extractLocation(address: string | undefined | null): { city: string; province: string } | null {
  if (!address) return null;
  const parts = address.split(',');
  if (parts.length < 2) return null;
  const city = (parts.at(-2) ?? '').replace(/[A-Z0-9]{4,}\s*/g, '').trim();
  const province = (parts.at(-1) ?? '').trim();
  if (!city || !province) return null;
  return { city, province };
}

export function LocationBreakdown({ rows, onCityClick }: LocationBreakdownProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups: ProvinceGroup[] = useMemo(() => {
    const byProvince = new Map<string, Map<string, number>>();

    for (const r of rows) {
      const loc = extractLocation(r.address);
      if (!loc) continue;
      if (!byProvince.has(loc.province)) byProvince.set(loc.province, new Map());
      const cities = byProvince.get(loc.province)!;
      cities.set(loc.city, (cities.get(loc.city) ?? 0) + 1);
    }

    return Array.from(byProvince.entries())
      .map(([province, cities]) => ({
        province,
        total: Array.from(cities.values()).reduce((a, b) => a + b, 0),
        cities: Array.from(cities.entries())
          .map(([city, count]) => ({ city, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8),
      }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);

  const points = useMemo(() =>
    rows.filter(r => r.latitude != null && r.longitude != null),
    [rows],
  );

  const mapCenter: [number, number] = points.length > 0
    ? [points[0].latitude!, points[0].longitude!]
    : [-34.6037, -58.3816];

  const toggle = (province: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(province) ? next.delete(province) : next.add(province);
      return next;
    });
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      borderLeft: '1px solid var(--border)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          Location breakdown
        </div>
      </div>

      {/* Mini map */}
      <div style={{ flexShrink: 0, height: '160px', borderBottom: '1px solid var(--border)' }}>
        <MapContainer
          key={points.length}
          center={mapCenter}
          zoom={points.length > 0 ? 9 : 5}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
          scrollWheelZoom={false}
          dragging={false}
          attributionControl={false}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
            maxZoom={20}
          />
          {points.map(r => (
            <CircleMarker
              key={r.id}
              center={[r.latitude!, r.longitude!]}
              radius={4}
              pathOptions={{ color: 'var(--accent)', fillColor: 'var(--accent)', fillOpacity: 0.65, weight: 0 }}
            />
          ))}
        </MapContainer>
      </div>

      {/* Province → City hierarchy */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {groups.length === 0 ? (
          <div style={{ padding: '24px 14px', fontFamily: 'var(--font-ui)', fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center' }}>
            No location data
          </div>
        ) : groups.map(g => {
          const isCollapsed = collapsed.has(g.province);
          return (
            <div key={g.province} style={{ borderBottom: '1px solid var(--border)' }}>
              {/* Province row */}
              <button
                onClick={() => toggle(g.province)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '9px 14px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)')}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'none')}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted)', width: '10px', flexShrink: 0 }}>
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.province}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--accent)', flexShrink: 0 }}>
                  {g.total}
                </span>
              </button>

              {/* City rows */}
              {!isCollapsed && g.cities.map(c => (
                <div
                  key={c.city}
                  onClick={() => onCityClick?.(c.city)}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px 6px 32px', cursor: onCityClick ? 'pointer' : 'default' }}
                  onMouseEnter={e => { if (onCityClick) (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)'; }}
                  onMouseLeave={e => { if (onCityClick) (e.currentTarget as HTMLElement).style.background = 'none'; }}
                >
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.city}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-muted)', flexShrink: 0 }}>
                    {c.count}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
