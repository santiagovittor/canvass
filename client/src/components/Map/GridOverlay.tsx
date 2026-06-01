import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import type { GridCell } from '../../types';

const CELL_STYLE: L.PathOptions = {
  color: 'var(--accent)',
  weight: 1,
  opacity: 0.6,
  fillColor: 'var(--accent)',
  fillOpacity: 0.06,
  dashArray: '2,3',
  interactive: false,
};

const CELL_STYLE_WARN: L.PathOptions = {
  ...CELL_STYLE,
  color: '#F5B700',
  fillColor: '#F5B700',
};

const CELL_STYLE_DANGER: L.PathOptions = {
  ...CELL_STYLE,
  color: '#FF4D6D',
  fillColor: '#FF4D6D',
};

interface GridOverlayProps {
  cells: GridCell[];
  cellCount: number;
}

export function GridOverlay({ cells, cellCount }: GridOverlayProps) {
  const map = useMap();
  const layerRef = useRef<L.FeatureGroup | null>(null);

  useEffect(() => {
    if (layerRef.current) {
      map.removeLayer(layerRef.current);
    }

    if (cells.length === 0) {
      layerRef.current = null;
      return;
    }

    const style = cellCount > 60
      ? CELL_STYLE_DANGER
      : cellCount > 30
        ? CELL_STYLE_WARN
        : CELL_STYLE;

    const group = new L.FeatureGroup();
    for (const cell of cells) {
      L.rectangle(cell.bounds as L.LatLngBoundsExpression, style).addTo(group);
    }
    group.addTo(map);
    layerRef.current = group;

    return () => {
      if (layerRef.current) map.removeLayer(layerRef.current);
    };
  }, [cells, cellCount, map]);

  return null;
}
