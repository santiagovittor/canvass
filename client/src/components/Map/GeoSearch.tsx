import { useState } from 'react';
import L from 'leaflet';

interface GeoSearchProps {
  map: L.Map;
}

export function GeoSearch({ map }: GeoSearchProps) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`,
      );
      const data = await res.json();
      if (data.length > 0) {
        map.flyTo([parseFloat(data[0].lat), parseFloat(data[0].lon)], 15);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        position: 'absolute',
        top: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        background: 'rgba(26, 22, 16, 0.88)',
        border: `1px solid ${error ? 'var(--error)' : 'rgba(255, 245, 235, 0.09)'}`,
        borderRadius: '8px',
        padding: '7px 10px 7px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        width: '280px',
      }}
    >
      <input
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setError(false); }}
        placeholder={error ? 'Lugar no encontrado' : 'Buscar barrio o ciudad...'}
        style={{
          flex: 1,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          fontFamily: 'var(--font-ui)',
          fontSize: '13px',
          color: error ? 'var(--error)' : 'var(--text-primary)',
        }}
      />
      <button
        type="submit"
        disabled={loading}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: loading ? 'default' : 'pointer',
          color: loading ? 'var(--text-muted)' : error ? 'var(--error)' : 'var(--accent)',
          fontSize: '16px',
          lineHeight: 1,
          padding: '0 2px',
          flexShrink: 0,
        }}
      >
        {loading ? '·' : error ? '✕' : '→'}
      </button>
    </form>
  );
}
