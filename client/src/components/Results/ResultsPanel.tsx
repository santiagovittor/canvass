import { useState } from 'react';
import { ResultsTable } from './ResultsTable';
import { ExportPanel } from './ExportPanel';
import type { Business } from '../../types';

interface ResultsPanelProps {
  jobId: string | null;
  results: Business[];
}

export function ResultsPanel({ jobId, results }: ResultsPanelProps) {
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

      <ResultsTable results={results} filter={filter} />

      {jobId && results.length > 0 && (
        <ExportPanel jobId={jobId} results={results} />
      )}
    </div>
  );
}
