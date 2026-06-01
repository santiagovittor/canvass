import { estimateBusinesses, estimateMinutes } from '../../lib/geo';
import { formatCount } from '../../lib/format';

interface AreaStatsProps {
  cellCount: number;
  cellSizeKm: number;
  onCellSizeChange: (km: number) => void;
  jobActive?: boolean;
  cellsDone?: number;
}

function fmtEta(minutes: number): string {
  return minutes >= 60 ? `~${Math.ceil(minutes / 60)}h` : `~${minutes}m`;
}

export function AreaStats({ cellCount, cellSizeKm, onCellSizeChange, jobActive, cellsDone }: AreaStatsProps) {
  const estBusinesses = estimateBusinesses(cellCount);
  const remainingCells = jobActive && cellsDone != null ? cellCount - cellsDone : cellCount;
  const estMinutes = estimateMinutes(remainingCells);
  const isWarn = cellCount > 30;
  const isDanger = cellCount > 60;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="bento-grid">
        <div className="bento-cell">
          <span className="bento-label">Cells</span>
          <span className="bento-value">{formatCount(cellCount)}</span>
        </div>
        <div className="bento-cell">
          <span className="bento-label">Est. Businesses</span>
          <span className="bento-value">{formatCount(estBusinesses)}</span>
        </div>
        <div className="bento-cell">
          <span className="bento-label">{jobActive ? 'Time Left' : 'Est. Time'}</span>
          <span className="bento-value">{fmtEta(estMinutes)}</span>
        </div>
        <div className="bento-cell">
          <span className="bento-label">Cell Size</span>
          <span className="bento-value">{cellSizeKm.toFixed(1)}<span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>km</span></span>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Cell Size
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {cellSizeKm.toFixed(1)} km
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.1}
          value={cellSizeKm}
          onChange={e => onCellSizeChange(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--accent)' }}
        />
      </div>

      {isDanger && (
        <div style={{
          background: 'rgba(255,77,109,0.1)',
          border: '1px solid rgba(255,77,109,0.3)',
          borderRadius: '8px',
          padding: '10px 14px',
          color: '#FF4D6D',
          fontFamily: 'var(--font-ui)',
          fontSize: '13px',
        }}>
          ✕ Area too large. Reduce selection or increase cell size.
        </div>
      )}
      {isWarn && !isDanger && (
        <div style={{
          background: 'rgba(245,183,0,0.1)',
          border: '1px solid rgba(245,183,0,0.3)',
          borderRadius: '8px',
          padding: '10px 14px',
          color: '#F5B700',
          fontFamily: 'var(--font-ui)',
          fontSize: '13px',
        }}>
          ⚠ Large area — scrape may take &gt;15 min
        </div>
      )}
    </div>
  );
}
