import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';

interface DrawControlsProps {
  onPolygonChange: (polygon: [number, number][] | null) => void;
}

const DRAW_STYLE = { color: 'var(--accent)', weight: 2, opacity: 0.9, fillOpacity: 0.08, fillColor: 'var(--accent)' };

export function DrawControls({ onPolygonChange }: DrawControlsProps) {
  const map = useMap();
  const callbackRef = useRef(onPolygonChange);
  useEffect(() => { callbackRef.current = onPolygonChange; });

  useEffect(() => {
    const featureGroup = new L.FeatureGroup();
    map.addLayer(featureGroup);

    const drawControl = new (L.Control as any).Draw({
      position: 'topright',
      draw: {
        rectangle: { shapeOptions: DRAW_STYLE },
        polygon: { shapeOptions: DRAW_STYLE },
        circle: false,
        marker: false,
        polyline: false,
        circlemarker: false,
      },
      edit: { featureGroup },
    });
    map.addControl(drawControl);

    const onCreated = (e: any) => {
      featureGroup.clearLayers();
      featureGroup.addLayer(e.layer);
      const latlngs = (e.layer as L.Polygon).getLatLngs()[0] as L.LatLng[];
      callbackRef.current(latlngs.map(ll => [ll.lat, ll.lng]));
    };

    const onEdited = (e: any) => {
      e.layers.eachLayer((layer: any) => {
        const latlngs = (layer as L.Polygon).getLatLngs()[0] as L.LatLng[];
        callbackRef.current(latlngs.map(ll => [ll.lat, ll.lng]));
      });
    };

    const onDeleted = () => callbackRef.current(null);

    map.on(L.Draw.Event.CREATED, onCreated);
    map.on(L.Draw.Event.EDITED, onEdited);
    map.on(L.Draw.Event.DELETED, onDeleted);

    return () => {
      map.off(L.Draw.Event.CREATED, onCreated);
      map.off(L.Draw.Event.EDITED, onEdited);
      map.off(L.Draw.Event.DELETED, onDeleted);
      map.removeControl(drawControl);
      map.removeLayer(featureGroup);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
