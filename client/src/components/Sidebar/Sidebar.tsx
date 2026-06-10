import { AreaStats } from './AreaStats';
import { SearchPanel } from './SearchPanel';
import { JobProgress } from './JobProgress';
import type { JobStatus } from '../../types';

interface SidebarProps {
  visible: boolean;
  cellCount: number;
  cellSizeKm: number;
  onCellSizeChange: (km: number) => void;
  jobActive: boolean;
  jobId: string | null;
  jobStatus: JobStatus | null;
  cellsDone: number;
  totalResults: number;
  enrichedDone: number;
  enrichedTotal: number;
  eventLog: string[];
  onStart: (searchTerm: string, language: string, extractEmails: boolean) => void;
  onCancel: () => void;
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
  totalResults,
  enrichedDone,
  enrichedTotal,
  eventLog,
  onStart,
  onCancel,
}: SidebarProps) {
  if (!visible) {
    return (
      <div style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-panel)',
        borderRight: '1px solid var(--border)',
      }}>
        <span style={{
          fontFamily: 'var(--font-ui)',
          fontSize: '12px',
          color: 'var(--text-muted)',
          textAlign: 'center',
          padding: '0 24px',
          letterSpacing: '0.03em',
        }}>
          Draw an area to begin
        </span>
      </div>
    );
  }

  const isDanger = cellCount > 60;

  return (
    <div
      className="sidebar-left sidebar-reveal"
      style={{
        height: '100vh',
        overflowY: 'auto',
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
            totalResults={totalResults}
            enrichedDone={enrichedDone}
            enrichedTotal={enrichedTotal}
            eventLog={eventLog}
            onCancel={onCancel}
          />
        </div>
      )}
    </div>
  );
}
