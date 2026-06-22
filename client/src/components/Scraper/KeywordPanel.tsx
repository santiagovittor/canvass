import { useState } from 'react';
import { instantKeywordScrape, type InstantScrapeResult } from '../../lib/keywordScrapeApi';
import { createScrapeSchedule } from '../../lib/scrapeSchedulesApi';
import { useKeywordRun, type KeywordStage } from '../../hooks/useKeywordRun';

const LANGS = ['en', 'es', 'pt', 'de', 'fr', 'it'];

// Stage tracker steps for an instant keyword run (slice 0003). Each step's rank
// marks where it sits in the run lifecycle; 'submitting' shares rank 1 with
// 'scraping' so the first step lights up the moment the request is dispatched.
const STAGE_RANK: Record<KeywordStage, number> = {
  idle: 0, submitting: 1, scraping: 1, saving: 2, enriching: 3, done: 4, error: -1,
};
const STAGE_STEPS: { label: string; rank: number }[] = [
  { label: 'Scraping', rank: 1 },
  { label: 'Saving', rank: 2 },
  { label: 'Enriching', rank: 3 },
  { label: 'Done', rank: 4 },
];

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function KeywordPanel() {
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
  const [bulkRunning, setBulkRunning] = useState(false);
  const run = useKeywordRun();

  const geoBias =
    geoLat && geoLng
      ? { lat: geoLat, lon: geoLng, radius: parseInt(geoRadius) || 2000 }
      : undefined;

  async function handleRunNow() {
    if (!query.trim()) return;
    setRunning(true);
    setResult(null);
    setError(null);
    const runId = crypto.randomUUID();
    run.start(runId);
    try {
      const r = await instantKeywordScrape({
        query: query.trim(),
        lang,
        depth: parseInt(depth) || 5,
        geoBias,
        runId,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Request failed before/around the server's keyword:error (e.g. 400/network)
      // — clear the tracker so the inline error is the single source of truth.
      run.reset();
    } finally {
      setRunning(false);
    }
  }

  async function handleAddToBacklog() {
    if (!query.trim()) return;
    try {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleBulkEnqueue() {
    const lines = bulkText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length || bulkRunning) return;
    setBulkRunning(true);
    try {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkRunning(false);
    }
  }

  const bulkLines = bulkText.split('\n').filter((l) => l.trim()).length;

  return (
    <div className="keyword-panel">
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
        </div>

        <p className="kp-hint">
          Emails are found by visiting each business's website after scraping.
          Leads without a website won't have one.
        </p>

        <button
          className="kp-advanced-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? '▴ Advanced / Queue' : '▾ Advanced / Queue'}
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

            {/* Queue (run later via the scheduler) */}
            <div className="kp-queue">
              <span className="sidebar-section-label kp-queue-label">Queue for later</span>
              <button
                className="btn-secondary kp-queue-btn"
                onClick={handleAddToBacklog}
                disabled={running || !query.trim()}
              >
                + Add current query to backlog
              </button>

              <div className="kp-queue-div">or queue a batch</div>

              <textarea
                className="input-field kp-textarea"
                rows={5}
                placeholder={'one query per line\ndentists in miami\nkioskos in palermo'}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
              />
              <button
                className="btn-secondary kp-queue-btn"
                onClick={handleBulkEnqueue}
                disabled={bulkLines === 0 || bulkRunning}
              >
                {bulkRunning ? 'Adding…' : (
                  <>Add {bulkLines > 0 && <span className="kp-btn-count">{bulkLines}</span>} to backlog</>
                )}
              </button>

              {enqueued && (
                <p className="kp-queued">
                  Queued ✓ — runs in ~<span className="kp-queued-num">60s</span>, results appear in the Explorer tab.
                </p>
              )}
            </div>
          </div>
        )}

        {run.stage !== 'idle' && run.stage !== 'error' && (
          <div className="kp-stages">
            <div className="kp-stages-row">
              {STAGE_STEPS.map(({ label, rank }) => {
                const current = STAGE_RANK[run.stage];
                const cls =
                  current > rank ? ' kp-stage--done'
                  : current === rank ? ' kp-stage--active'
                  : '';
                return (
                  <span key={label} className={`kp-stage${cls}`}>
                    <span className="kp-stage-dot" />
                    {label}
                  </span>
                );
              })}
            </div>
            <span className="kp-elapsed">{formatElapsed(run.elapsedMs)}</span>
            {run.stage !== 'done' && (
              <span className="kp-stage-hint">~90s typical</span>
            )}
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
    </div>
  );
}
