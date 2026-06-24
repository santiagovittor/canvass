import { AreaStats } from './AreaStats';
import { SearchPanel } from './SearchPanel';
import { JobProgress } from './JobProgress';
import { ScrapeSchedulerStatus } from '../Scraper/ScrapeSchedulerStatus';
import { SchedulesList } from '../Scraper/SchedulesList';
import type { JobStatus } from '../../types';
import type { SweepActivity } from './JobProgress';

interface SidebarProps {
  visible: boolean;
  cellCount: number;
  cellSizeKm: number;
  onCellSizeChange: (km: number) => void;
  jobActive: boolean;
  jobId: string | null;
  jobStatus: JobStatus | null;
  cellsDone: number;
  sweep: SweepActivity | null;
  totalResults: number;
  enrichedDone: number;
  enrichedTotal: number;
  eventLog: string[];
  onStart: (searchTerm: string, language: string, extractEmails: boolean) => void;
  onCancel: () => void;
  onResume: () => void;
  geometry: { type: string; coordinates: number[][][] } | null;
}

export function Sidebar({
  visible,
  cellCount,
  cellSizeKm,
  onCellSizeChange,
  jobActive,
  jobId,
  jobStatus,
  cellsDone,
  sweep,
  totalResults,
  enrichedDone,
  enrichedTotal,
  eventLog,
  onStart,
  onCancel,
  onResume,
  geometry,
}: SidebarProps) {
  if (!visible) {
    return (
      <div style={{ height: '100%', background: 'var(--bg-panel)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '32px 24px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', letterSpacing: '0.03em' }}>
            Draw an area to begin
          </span>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-section-label">Scheduler</div>
          <ScrapeSchedulerStatus />
        </div>
        <div className="sidebar-section" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderBottom: 'none', paddingBottom: 0 }}>
          <div className="sidebar-section-label">Schedules</div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 16 }}>
            <SchedulesList geometry={geometry} />
          </div>
        </div>
      </div>
    );
  }

  const isDanger = cellCount > 60;

  return (
    <div
      className="sidebar-left sidebar-reveal"
      style={{
        height: '100%',
        background: 'var(--bg-panel)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div className="sidebar-section">
        <div className="sidebar-section-label">Area</div>
        <AreaStats
          cellCount={cellCount}
          cellSizeKm={cellSizeKm}
          onCellSizeChange={onCellSizeChange}
          jobActive={jobActive}
          cellsDone={cellsDone}
        />
      </div>

      {!jobActive && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">Search</div>
          <SearchPanel disabled={cellCount === 0} isDanger={isDanger} onStart={onStart} />
        </div>
      )}

      {(jobActive || (jobStatus && jobStatus !== 'pending')) && jobId && jobStatus && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">Progress</div>
          <JobProgress
            jobId={jobId}
            status={jobStatus}
            cellsDone={cellsDone}
            cellCount={cellCount}
            sweep={sweep}
            totalResults={totalResults}
            enrichedDone={enrichedDone}
            enrichedTotal={enrichedTotal}
            eventLog={eventLog}
            onCancel={onCancel}
            onResume={onResume}
          />
        </div>
      )}

      <div className="sidebar-section">
        <div className="sidebar-section-label">Scheduler</div>
        <ScrapeSchedulerStatus />
      </div>
      <div className="sidebar-section" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderBottom: 'none', paddingBottom: 0 }}>
        <div className="sidebar-section-label">Schedules</div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 16 }}>
          <SchedulesList geometry={geometry} />
        </div>
      </div>
    </div>
  );
}
