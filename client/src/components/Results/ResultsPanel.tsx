import { useState } from 'react';
import { ResultsTable } from './ResultsTable';
import { ExportPanel } from './ExportPanel';
import type { Business, JobStatus } from '../../types';

interface ResultsPanelProps {
  jobId: string | null;
  results: Business[];
  status: JobStatus | null;
  cellsDone: number;
  totalCells: number;
}

export function ResultsPanel({ jobId, results, status, cellsDone, totalCells }: ResultsPanelProps) {
  const [filter, setFilter] = useState('');

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-panel)',
      borderLeft: '1px solid var(--border)',
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>
          Results
        </span>
        {results.length > 0 && (
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter…"
            style={{
              flex: 1,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '6px 10px',
              fontFamily: 'var(--font-ui)',
              fontSize: '12px',
              color: 'var(--text-primary)',
              outline: 'none',
              minWidth: 0,
            }}
          />
        )}
      </div>

      {results.length === 0 ? (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '32px 20px',
        }}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="9" width="24" height="18" rx="2" stroke="var(--text-muted)" strokeWidth="1.2"/>
            <path d="M4 14h24" stroke="var(--text-muted)" strokeWidth="1.2"/>
            <path d="M10 19h4M10 23h8" stroke="var(--text-muted)" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M12 5l4 4 4-4" stroke="var(--text-muted)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '12px',
            color: 'var(--text-muted)',
            textAlign: 'center',
            lineHeight: 1.5,
          }}>
            {jobId ? 'Waiting for results…' : 'Results appear here during a scrape'}
          </span>
        </div>
      ) : (
        <>
          <ResultsTable results={results} filter={filter} />
          {status === 'error' && (
            <div style={{ padding: '8px 16px', fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
              Partial results — job stopped at cell{' '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>{cellsDone}</span>
              {' '}of{' '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>{totalCells}</span>.
            </div>
          )}
        </>
      )}

      {jobId && results.length > 0 && (
        <ExportPanel jobId={jobId} results={results} />
      )}
    </div>
  );
}
