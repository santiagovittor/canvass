export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export function bboxFromGeoJSON(geometry: { type: string; coordinates: number[][][] }): Bbox {
  const coords = geometry.coordinates[0];
  const lons = coords.map(([lon]) => lon);
  const lats = coords.map(([, lat]) => lat);
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  };
}

// bbox → GeoJSON rectangle polygon in [lng, lat] order (slice 0037). Closed ring
// (first vertex repeated last), CCW winding. Feeds StartJobParams.geometry so a
// resolved city box runs through the same grid scraper as a map-drawn polygon.
// pointInPolygon (jobRunner.ts) is winding-agnostic; the closed ring is what matters.
export function polygonFromBbox(bbox: Bbox): { type: 'Polygon'; coordinates: number[][][] } {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  return {
    type: 'Polygon',
    coordinates: [[
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat],
      [minLon, minLat],
    ]],
  };
}

function dLat(cellKm: number): number {
  return cellKm / 111;
}

function dLon(cellKm: number, midLat: number): number {
  return cellKm / (111 * Math.cos((midLat * Math.PI) / 180));
}

export function computeGrid(bbox: Bbox, cellKm: number): Bbox[] {
  const latStep = dLat(cellKm);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const lonStep = dLon(cellKm, midLat);
  const cells: Bbox[] = [];
  for (let lat = bbox.minLat; lat < bbox.maxLat; lat += latStep) {
    for (let lon = bbox.minLon; lon < bbox.maxLon; lon += lonStep) {
      cells.push({
        minLat: lat,
        maxLat: Math.min(lat + latStep, bbox.maxLat),
        minLon: lon,
        maxLon: Math.min(lon + lonStep, bbox.maxLon),
      });
    }
  }
  return cells;
}

export function cellCount(bbox: Bbox, cellKm: number): number {
  const latStep = dLat(cellKm);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const lonStep = dLon(cellKm, midLat);
  const rows = Math.ceil((bbox.maxLat - bbox.minLat) / latStep);
  const cols = Math.ceil((bbox.maxLon - bbox.minLon) / lonStep);
  return Math.max(rows, 0) * Math.max(cols, 0);
}
