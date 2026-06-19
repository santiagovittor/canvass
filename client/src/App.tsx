import { useState, useCallback, useRef } from 'react';
import { MapView } from './components/Map/MapView';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ResultsPanel } from './components/Results/ResultsPanel';
import { BusinessExplorer } from './components/Explorer/BusinessExplorer';
import { Outreach } from './pages/Outreach';
import { Analytics } from './pages/Analytics';
import { Settings } from './pages/Settings';
import { KeywordPanel } from './components/Scraper/KeywordPanel';
import { useSSE } from './hooks/useSSE';
import { useScrape } from './hooks/useScrape';
import { useResults } from './hooks/useResults';
import { bboxFromGeoJSON, computeGrid, cellCount as computeCellCount } from './lib/geo';
import { getResults } from './lib/api';
import type { Business, JobStartedEvent, JobProgressEvent, JobScrapedEvent, JobDoneEvent, JobErrorEvent, EnrichProgressEvent, BusinessesUpdatedEvent, SnapshotEvent, GridCell } from './types';

const DEFAULT_CELL_SIZE_KM = 0.7;

export default function App() {
  const [geometry, setGeometry] = useState<{ type: string; coordinates: number[][][] } | null>(null);
  const [cellSizeKm, setCellSizeKm] = useState(DEFAULT_CELL_SIZE_KM);
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [hydratedCellCount, setHydratedCellCount] = useState(0);
  // Last completed sweep batch — drives the "job is alive" indicator
  const [sweep, setSweep] = useState<{ jobsDone: number; jobsTotal: number; category: string; at: number } | null>(null);

  const bbox = geometry ? bboxFromGeoJSON(geometry) : null;
  const cells: GridCell[] = bbox ? computeGrid(bbox, cellSizeKm) : [];
  const count = bbox ? computeCellCount(bbox, cellSizeKm) : 0;

  const { jobId, status, setStatus, setJobId, error, start, cancel, resume } = useScrape();
  const { results, businessCount, cellsDone, enrichedDone, enrichedTotal, addResult, setResults, updateProgress, updateBusinessCount, updateEnrichProgress, reset: resetResults } = useResults();

  const log = useCallback((msg: string) => {
    setEventLog(prev => [...prev.slice(-49), `${new Date().toLocaleTimeString()} ${msg}`]);
  }, []);

  const loggedCellRef = useRef(-1);

  useSSE({
    'snapshot': (data) => {
      const e = data as SnapshotEvent;
      if (!('id' in e)) return;
      setJobId(e.id);
      setStatus(e.status);
      updateBusinessCount(e.businessesFound);
      setHydratedCellCount(e.cellCount);
      if (e.status === 'error') {
        updateProgress(e.cellsDone);
        if (e.businessesFound > 0) getResults(e.id).then(setResults).catch(() => {});
      }
    },
    'job:started': (data) => {
      const e = data as JobStartedEvent;
      if (e.jobId !== jobId && jobId !== null) return;
      setStatus('running');
      log(`Started — ${e.cellCount} cells`);
    },
    'job:progress': (data) => {
      const e = data as JobProgressEvent;
      if (jobId && e.jobId !== jobId) return;
      updateProgress(e.cellsDone);
      updateBusinessCount(e.totalBusinesses);
      setSweep({ jobsDone: e.jobsDone, jobsTotal: e.jobsTotal, category: e.category, at: Date.now() });
      if (e.cellsDone > loggedCellRef.current) {
        loggedCellRef.current = e.cellsDone;
        log(`Cell ${e.cellsDone + 1} — ${e.totalBusinesses} businesses`);
      }
    },
    'job:scraped': (data) => {
      const e = data as JobScrapedEvent;
      if (jobId && e.jobId !== jobId) return;
      log(`Scraped ${e.count} businesses`);
      getResults(e.jobId).then(setResults).catch(() => {});
    },
    'job:done': (data) => {
      const e = data as JobDoneEvent;
      if (jobId && e.jobId !== jobId) return;
      setStatus('done');
      log('Done');
    },
    'job:error': (data) => {
      const e = data as JobErrorEvent;
      if (jobId && e.jobId !== jobId) return;
      setStatus('error');
      if (e.cellsDone !== undefined) updateProgress(e.cellsDone);
      if (e.businessesFound !== undefined) updateBusinessCount(e.businessesFound);
      if (e.cellCount !== undefined) setHydratedCellCount(e.cellCount);
      log(`Error: ${e.message}`);
    },
    // Enrichment runs in a background queue decoupled from job status — the
    // job stays "done" while the Social Profiles bar fills in below.
    'enrich:progress': (data) => {
      const e = data as EnrichProgressEvent;
      if (jobId && e.jobId !== jobId) return;
      updateEnrichProgress(e.done, e.total);
    },
    'businesses_updated': (data) => {
      const e = data as BusinessesUpdatedEvent;
      if (jobId && e.jobId !== jobId) return;
      getResults(e.jobId).then(setResults).catch(() => {});
      log(`Cell done — ${e.count} businesses total`);
    },
  });

  const handleStart = useCallback(async (searchTerm: string, language: string, extractEmails: boolean) => {
    if (!geometry) return;
    resetResults();
    setEventLog([]);
    loggedCellRef.current = -1;
    setSweep(null);
    setJobId(null);
    setStatus(null);
    await start({ geometry, searchTerm, language, gridCellKm: cellSizeKm, extractEmails });
  }, [geometry, cellSizeKm, start, resetResults, setJobId, setStatus]);

  const handlePolygonChange = useCallback((coords: [number, number][] | null) => {
    if (!coords) { setGeometry(null); return; }
    // Leaflet gives [lat, lng]; GeoJSON needs [lng, lat]
    const ring = coords.map(([lat, lng]) => [lng, lat] as [number, number]);
    ring.push(ring[0]); // close ring
    setGeometry({ type: 'Polygon', coordinates: [ring] });
  }, []);

  const jobActive = jobId !== null && status !== null && status !== 'done' && status !== 'error';
  const sidebarVisible = geometry !== null || jobActive;
  const displayCellCount = count || hydratedCellCount;

  const [view, setView] = useState<'scraper' | 'explorer' | 'outreach' | 'analytics' | 'settings'>('scraper');
  const [outreachSentAt, setOutreachSentAt] = useState(0);
  const [scraperMode, setScraperMode] = useState<'map' | 'keyword'>('map');

  return (
    <div className="app-root">
      <div className="tab-strip">
        <span style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontFamily: 'var(--font-ui)',
          fontWeight: 700,
          fontSize: '11px',
          letterSpacing: '0.1em',
          color: 'var(--text-secondary)',
          userSelect: 'none',
          paddingRight: '12px',
          marginRight: '4px',
          borderRight: '1px solid var(--border)',
        }}>
          <span style={{
            width: '7px',
            height: '7px',
            borderRadius: '2px',
            background: 'var(--accent)',
            flexShrink: 0,
          }} />
          MAPS·SCRAPER
        </span>
        <button
          className={`tab-btn${view === 'scraper' ? ' tab-btn--active' : ''}`}
          onClick={() => setView('scraper')}
        >
          Scraper
        </button>
        <button
          className={`tab-btn${view === 'explorer' ? ' tab-btn--active' : ''}`}
          onClick={() => setView('explorer')}
        >
          Explorer
        </button>
        <button
          className={`tab-btn${view === 'outreach' ? ' tab-btn--active' : ''}`}
          onClick={() => setView('outreach')}
        >
          Outreach
        </button>
        <button
          className={`tab-btn${view === 'analytics' ? ' tab-btn--active' : ''}`}
          onClick={() => setView('analytics')}
        >
          Analytics
        </button>
        <button
          className={`tab-btn${view === 'settings' ? ' tab-btn--active' : ''}`}
          onClick={() => setView('settings')}
        >
          Settings
        </button>
      </div>

      {view === 'scraper' ? (
        <div className="app-grid">
          <Sidebar
            visible={sidebarVisible}
            cellCount={displayCellCount}
            cellSizeKm={cellSizeKm}
            onCellSizeChange={setCellSizeKm}
            jobActive={jobActive}
            jobId={jobId}
            jobStatus={status}
            cellsDone={cellsDone}
            sweep={sweep}
            totalResults={businessCount}
            enrichedDone={enrichedDone}
            enrichedTotal={enrichedTotal}
            eventLog={eventLog}
            onStart={handleStart}
            onCancel={cancel}
            onResume={resume}
            geometry={geometry}
          />
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
            <div className="scraper-mode-bar">
              <div className="scraper-mode-toggle">
                <button
                  className={`scraper-mode-btn${scraperMode === 'map' ? ' scraper-mode-btn--active' : ''}`}
                  onClick={() => setScraperMode('map')}
                >Map</button>
                <button
                  className={`scraper-mode-btn${scraperMode === 'keyword' ? ' scraper-mode-btn--active' : ''}`}
                  onClick={() => setScraperMode('keyword')}
                >Keywords</button>
              </div>
            </div>
            {scraperMode === 'map' ? (
              <MapView
                onPolygonChange={handlePolygonChange}
                cells={cells}
                cellCount={count}
              />
            ) : (
              <KeywordPanel />
            )}
          </div>
          <ResultsPanel jobId={jobId} results={results} status={status} cellsDone={cellsDone} totalCells={displayCellCount} />
        </div>
      ) : view === 'explorer' ? (
        <div className="view-fill">
          <BusinessExplorer refreshTrigger={outreachSentAt} />
        </div>
      ) : view === 'outreach' ? (
        <div className="view-fill">
          <Outreach onEmailSent={() => setOutreachSentAt(Date.now())} />
        </div>
      ) : view === 'analytics' ? (
        <div className="view-fill">
          <Analytics />
        </div>
      ) : (
        <div className="view-fill">
          <Settings />
        </div>
      )}
    </div>
  );
}
