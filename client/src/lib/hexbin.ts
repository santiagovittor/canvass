// Pointy-top hexagonal binning over lat/lng points, done in a local planar
// projection (equirectangular around the data centroid). Pure math — no deps.
// Replaces leaflet-hexbin, which would pull in d3 against the no-lodash/no-d3
// architecture rule; the binning itself is ~60 lines.

import type { GeoPoint } from './analyticsApi';

export interface HexBin {
  corners: [number, number][]; // [lat, lng] ring for react-leaflet Polygon
  count: number;
  withEmail: number;
  contacted: number;
}

const M_PER_DEG_LAT = 111320;

export function computeHexbins(points: GeoPoint[], radiusMeters = 400): HexBin[] {
  if (points.length === 0) return [];

  const centerLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180);
  const R = radiusMeters;

  const bins = new Map<string, { q: number; r: number; count: number; withEmail: number; contacted: number }>();

  for (const p of points) {
    const x = p.lng * mPerDegLng;
    const y = p.lat * M_PER_DEG_LAT;

    // axial coords (pointy-top), then cube rounding
    const qf = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / R;
    const rf = ((2 / 3) * y) / R;
    let q = Math.round(qf);
    let r = Math.round(rf);
    const s = Math.round(-qf - rf);
    const dq = Math.abs(q - qf);
    const dr = Math.abs(r - rf);
    const ds = Math.abs(s - (-qf - rf));
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;

    const key = `${q},${r}`;
    const bin = bins.get(key) ?? { q, r, count: 0, withEmail: 0, contacted: 0 };
    bin.count++;
    bin.withEmail += p.e;
    bin.contacted += p.c;
    bins.set(key, bin);
  }

  const result: HexBin[] = [];
  for (const bin of bins.values()) {
    const cx = R * (Math.sqrt(3) * bin.q + (Math.sqrt(3) / 2) * bin.r);
    const cy = R * ((3 / 2) * bin.r);
    const corners: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 30); // pointy-top corners
      const vx = cx + R * Math.cos(angle);
      const vy = cy + R * Math.sin(angle);
      corners.push([vy / M_PER_DEG_LAT, vx / mPerDegLng]);
    }
    result.push({ corners, count: bin.count, withEmail: bin.withEmail, contacted: bin.contacted });
  }

  return result;
}
