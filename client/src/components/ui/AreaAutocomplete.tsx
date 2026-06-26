import { useEffect, useRef, useState } from 'react';
import { useAreaAutocomplete } from '../../hooks/useAreaAutocomplete';
import type { GeoPlace } from '../../lib/api';

// Area autocomplete dropdown (slice 0038). GeoNames-backed suggestions with a
// population chip; keyboard nav (↑/↓/Enter/Esc). Suggestion-only — picking fills
// the field and hands the place (with population) up; the real bbox still comes
// from the existing Preview/Nominatim resolve.
interface Props {
  value: string;
  onChange: (v: string) => void;
  onPick: (place: GeoPlace) => void;
  onEnter?: () => void; // Enter with no highlighted suggestion (e.g. trigger Preview)
  placeholder?: string;
  autoFocus?: boolean;
}

function placeLabel(p: GeoPlace): string {
  return [p.name, p.admin1, p.country].filter(Boolean).join(', ');
}

export function AreaAutocomplete({ value, onChange, onPick, onEnter, placeholder, autoFocus }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const results = useAreaAutocomplete(value, open);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => { setActive(-1); }, [results]);

  const show = open && results.length > 0;

  function pick(p: GeoPlace) {
    onChange(placeLabel(p));
    onPick(p);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!show) {
      if (e.key === 'Enter') onEnter?.();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) pick(results[active]); else onEnter?.();
    } else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
  }

  return (
    <div className="kp-ac" ref={wrapRef}>
      <input
        autoFocus={autoFocus}
        className="input-field kp-query"
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
      />
      {show && (
        <ul className="kp-ac-menu" role="listbox">
          {results.map((p, i) => (
            <li
              key={`${p.lat},${p.lon},${i}`}
              role="option"
              aria-selected={i === active}
              className={`kp-ac-opt${i === active ? ' kp-ac-opt--active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(p); }}
            >
              <span className="kp-ac-label">{placeLabel(p)}</span>
              <span className="kp-ac-pop">{p.population.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
