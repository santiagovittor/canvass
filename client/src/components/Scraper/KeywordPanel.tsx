import { useState } from 'react';
import { instantKeywordScrape, type InstantScrapeResult } from '../../lib/keywordScrapeApi';
import { createScrapeSchedule } from '../../lib/scrapeSchedulesApi';

const LANGS = ['en', 'es', 'pt', 'de', 'fr', 'it'];

export function KeywordPanel() {
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState('en');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [geoLat, setGeoLat] = useState('');
  const [geoLng, setGeoLng] = useState('');
  const [geoRadius, setGeoRadius] = useState('2000');
  const [depth, setDepth] = useState('5');
  const [bulkText, setBulkText] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<InstantScrapeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enqueued, setEnqueued] = useState(false);

  const geoBias =
    geoLat && geoLng
      ? { lat: geoLat, lon: geoLng, radius: parseInt(geoRadius) || 2000 }
      : undefined;

  async function handleRunNow() {
    if (!query.trim()) return;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const r = await instantKeywordScrape({
        query: query.trim(),
        lang,
        depth: parseInt(depth) || 5,
        geoBias,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function handleAddToBacklog() {
    if (!query.trim()) return;
    await createScrapeSchedule({
      name: query.trim().slice(0, 60),
      kind: 'keyword',
      keyword_query: query.trim(),
      language: lang,
      geo_lat: geoLat || null,
      geo_lng: geoLng || null,
      geo_radius: geoLat ? parseInt(geoRadius) || 2000 : null,
      depth: parseInt(depth) || null,
      polygon_json: '{}',
      business_type: query.trim(),
      interval_minutes: 0,
      enabled: 1,
    });
    setEnqueued(true);
    setTimeout(() => setEnqueued(false), 3000);
  }

  async function handleBulkEnqueue() {
    const lines = bulkText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    await Promise.all(
      lines.map((q) =>
        createScrapeSchedule({
          name: q.slice(0, 60),
          kind: 'keyword',
          keyword_query: q,
          language: lang,
          polygon_json: '{}',
          business_type: q,
          interval_minutes: 0,
          enabled: 1,
        })
      )
    );
    setBulkText('');
    setEnqueued(true);
    setTimeout(() => setEnqueued(false), 3000);
  }

  const bulkLines = bulkText.split('\n').filter((l) => l.trim()).length;

  return (
    <div className="keyword-panel">
      {/* Single / Bulk toggle */}
      <div className="kp-mode-toggle">
        <button
          className={`kp-mode-btn${mode === 'single' ? ' kp-mode-btn--active' : ''}`}
          onClick={() => setMode('single')}
        >
          Single
        </button>
        <button
          className={`kp-mode-btn${mode === 'bulk' ? ' kp-mode-btn--active' : ''}`}
          onClick={() => setMode('bulk')}
        >
          Bulk
        </button>
      </div>

      {mode === 'single' ? (
        <div className="kp-single">
          <input
            autoFocus
            className="input-field kp-query"
            placeholder="e.g. lawyers in new york city"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !running && handleRunNow()}
          />
          <div className="kp-row">
            <select
              className="input-field kp-lang"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <button
              className="btn-primary kp-btn"
              onClick={handleRunNow}
              disabled={running || !query.trim()}
            >
              {running ? 'Running…' : 'Run Now'}
            </button>
            <button
              className="btn-secondary kp-btn"
              onClick={handleAddToBacklog}
              disabled={running || !query.trim()}
            >
              {enqueued ? 'Added ✓' : '+ Backlog'}
            </button>
          </div>

          <button
            className="kp-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? '▴ Advanced' : '▾ Advanced'}
          </button>

          {showAdvanced && (
            <div className="kp-advanced">
              <div className="kp-advanced-row">
                <span className="sidebar-section-label kp-advanced-label">Geo bias</span>
                <input
                  className="input-field kp-mono"
                  placeholder="-34.6037"
                  value={geoLat}
                  onChange={(e) => setGeoLat(e.target.value)}
                />
                <input
                  className="input-field kp-mono"
                  placeholder="-58.3816"
                  value={geoLng}
                  onChange={(e) => setGeoLng(e.target.value)}
                />
                <input
                  className="input-field kp-mono kp-radius"
                  placeholder="2000"
                  value={geoRadius}
                  onChange={(e) => setGeoRadius(e.target.value)}
                />
                <span className="kp-unit">m</span>
              </div>
              <div className="kp-advanced-row">
                <span className="sidebar-section-label kp-advanced-label">Depth</span>
                <input
                  className="input-field kp-mono kp-depth"
                  type="number"
                  min={1}
                  max={20}
                  value={depth}
                  onChange={(e) => setDepth(e.target.value)}
                />
              </div>
            </div>
          )}

          {error && <p className="kp-error">{error}</p>}
          {result && (
            <div className="kp-result">
              <span className="kp-result-stat">
                Added <span className="kp-result-num">{result.added}</span>
              </span>
              <span className="kp-result-stat">
                Deduped <span className="kp-result-num">{result.deduped}</span>
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="kp-bulk">
          <textarea
            className="input-field kp-textarea"
            rows={7}
            placeholder={'one query per line\ndentists in miami\nkioskos in palermo'}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <div className="kp-row">
            <select
              className="input-field kp-lang"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <button
              className="btn-primary kp-btn"
              onClick={handleBulkEnqueue}
              disabled={bulkLines === 0}
            >
              {enqueued ? 'Added ✓' : `Add ${bulkLines || ''} to Backlog`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
