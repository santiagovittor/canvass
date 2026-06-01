import { useState, useCallback, useRef } from 'react';
import { MapView } from './components/Map/MapView';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ResultsPanel } from './components/Results/ResultsPanel';
import { BusinessExplorer } from './components/Explorer/BusinessExplorer';
import { Outreach } from './pages/Outreach';
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

  const bbox = geometry ? bboxFromGeoJSON(geometry) : null;
  const cells: GridCell[] = bbox ? computeGrid(bbox, cellSizeKm) : [];
  const count = bbox ? computeCellCount(bbox, cellSizeKm) : 0;

  const { jobId, status, setStatus, setJobId, error, start, cancel } = useScrape();
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
      if (e.status === 'enriching') updateEnrichProgress(e.progress, e.businessesFound);
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
      log(`Error: ${e.message}`);
    },
    'enrich:progress': (data) => {
      const e = data as EnrichProgressEvent;
      if (jobId && e.jobId !== jobId) return;
      updateEnrichProgress(e.done, e.total);
      setStatus('enriching');
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

  const [view, setView] = useState<'scraper' | 'explorer' | 'outreach'>('scraper');
  const [outreachSentAt, setOutreachSentAt] = useState(0);

  return (
    <div className="app-root">
      <div className="tab-strip">
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
            totalResults={businessCount}
            enrichedDone={enrichedDone}
            enrichedTotal={enrichedTotal}
            eventLog={eventLog}
            onStart={handleStart}
            onCancel={cancel}
          />
          <MapView
            onPolygonChange={handlePolygonChange}
            cells={cells}
            cellCount={count}
          />
          <ResultsPanel jobId={jobId} results={results} />
        </div>
      ) : view === 'explorer' ? (
        <div className="view-fill">
          <BusinessExplorer refreshTrigger={outreachSentAt} />
        </div>
      ) : (
        <div className="view-fill">
          <Outreach onEmailSent={() => setOutreachSentAt(Date.now())} />
        </div>
      )}
    </div>
  );
}
