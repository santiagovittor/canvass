import { useEffect, useRef, useState } from 'react';
import { useAreaAutocomplete } from '../../hooks/useAreaAutocomplete';
import type { GeoPlace } from '../../lib/api';

// Area autocomplete dropdown (slice 0038; modernized 0041). GeoNames-backed
// suggestions with a country flag + population chip; matched text highlighted;
// loading/empty/hint states; recent picks on empty focus; inline ghost completion
// (Tab to accept). Picking hands the full place up — its coords drive the bbox
// resolve (slice 0041), no longer the rebuilt label string.
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

// ISO-2 country code → regional-indicator emoji flag. Pure, no assets.
function flagEmoji(country: string | null): string {
  if (!country || country.length !== 2) return '';
  const cc = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const RECENTS_KEY = 'kp-recent-areas';
const RECENTS_MAX = 5;

function loadRecents(): GeoPlace[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, RECENTS_MAX) : [];
  } catch { return []; }
}

function pushRecent(p: GeoPlace): GeoPlace[] {
  const key = `${p.lat},${p.lon}`;
  const next = [p, ...loadRecents().filter(r => `${r.lat},${r.lon}` !== key)].slice(0, RECENTS_MAX);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* quota — ignore */ }
  return next;
}

export function AreaAutocomplete({ value, onChange, onPick, onEnter, placeholder, autoFocus }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recents, setRecents] = useState<GeoPlace[]>(loadRecents);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { results, loading } = useAreaAutocomplete(value, open);

  const q = value.trim();
  const typing = q.length >= 2;
  // Recents only on a truly empty field; a 1-char query shows the keep-typing
  // hint instead. While typing (≥2) the live results drive navigation.
  const showRecents = !typing && q.length === 0 && recents.length > 0;
  const showHint = !typing && !showRecents;
  const items = typing ? results : (showRecents ? recents : []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => { setActive(-1); }, [results, open]);

  // Ghost completion: the leading remainder of the top result when the typed
  // value is a case-insensitive prefix of its name.
  const ghostTail = (() => {
    if (!typing || results.length === 0) return '';
    const name = results[0].name;
    if (value.length >= name.length) return '';
    return name.toLowerCase().startsWith(value.toLowerCase()) ? name.slice(value.length) : '';
  })();

  const showMenu = open;

  function pick(p: GeoPlace) {
    onChange(placeLabel(p));
    onPick(p);
    setRecents(pushRecent(p));
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Tab' && ghostTail) { e.preventDefault(); pick(results[0]); return; }
    if (!showMenu || items.length === 0) {
      if (e.key === 'Enter') onEnter?.();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) pick(items[active]); else onEnter?.();
    } else if (e.key === 'Escape') { setOpen(false); setActive(-1); }
  }

  // Matched leading substring length on the name (prefix search guarantees it).
  function matchLen(name: string): number {
    return Math.min(q.length, name.length);
  }

  function renderRow(p: GeoPlace, i: number) {
    const ml = typing ? matchLen(p.name) : 0;
    const region = [p.admin1, p.country].filter(Boolean).join(', ');
    return (
      <li
        key={`${p.lat},${p.lon},${i}`}
        role="option"
        aria-selected={i === active}
        className={`kp-ac-opt${i === active ? ' kp-ac-opt--active' : ''}`}
        onMouseEnter={() => setActive(i)}
        onMouseDown={(e) => { e.preventDefault(); pick(p); }}
      >
        <span className="kp-ac-flag" aria-hidden="true">{flagEmoji(p.country)}</span>
        <span className="kp-ac-label">
          <span className="kp-ac-match">{p.name.slice(0, ml)}</span>{p.name.slice(ml)}
          {region && <span className="kp-ac-region">, {region}</span>}
        </span>
        <span className="kp-ac-pop">{p.population.toLocaleString()}</span>
      </li>
    );
  }

  return (
    <div className="kp-ac" ref={wrapRef}>
      <div className="kp-ac-field">
        {ghostTail && (
          <div className="kp-ac-ghost" aria-hidden="true">
            <span className="kp-ac-ghost-typed">{value}</span><span className="kp-ac-ghost-tail">{ghostTail}</span>
          </div>
        )}
        <input
          autoFocus={autoFocus}
          className="input-field kp-query"
          placeholder={placeholder}
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showMenu}
          aria-autocomplete="list"
        />
      </div>
      {showMenu && (
        <ul className="kp-ac-menu" role="listbox">
          {showRecents && (
            <li className="kp-ac-section" role="presentation">Recientes</li>
          )}
          {showHint && (
            <li className="kp-ac-hint" role="presentation">Seguí escribiendo…</li>
          )}
          {typing && loading && results.length === 0 && (
            [0, 1, 2].map(i => (
              <li key={`sk${i}`} className="kp-ac-skel" role="presentation">
                <span className="kp-ac-skel-bar" />
              </li>
            ))
          )}
          {typing && !loading && results.length === 0 && (
            <li className="kp-ac-empty" role="presentation">Sin resultados</li>
          )}
          {items.map(renderRow)}
        </ul>
      )}
    </div>
  );
}
