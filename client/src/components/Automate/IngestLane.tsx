import { ScrapeSchedulerStatus } from '../Scraper/ScrapeSchedulerStatus';
import { SchedulesList } from '../Scraper/SchedulesList';
import { LaneHeader } from './LaneHeader';

// Ingest lane: where leads come from. Reuses the existing scrape-scheduler status
// + schedule list (both self-fetch + live via scrape-scheduler:tick SSE).
// Management (run-now / enable / delete) works here; creating a schedule needs a
// map polygon, so that entry point stays in the Scraper tab (cross-linked below).
export function IngestLane() {
  return (
    <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pane)', padding: 'var(--space-lane)' }}>
      <LaneHeader step={1} title="Ingesta" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ScrapeSchedulerStatus />
        <SchedulesList geometry={null} />
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', color: 'var(--text-muted)' }}>
          Para crear un schedule nuevo, dibujá un polígono en la pestaña Scraper.
        </span>
      </div>
    </section>
  );
}
