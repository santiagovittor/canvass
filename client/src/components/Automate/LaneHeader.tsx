import type { CSSProperties, ReactNode } from 'react';

interface LaneHeaderProps {
  step: number;
  title: string;
  /** Right-aligned status slot (scheduler health, counts, etc.). */
  status?: ReactNode;
}

// Numbered lane header for the Automate pipeline (ingest → prepare → send).
// Step badge in mono, title in the UI face, optional right-aligned status.
const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  paddingBottom: 14,
  marginBottom: 16,
  borderBottom: '1px solid var(--hairline)',
};
const badge: CSSProperties = {
  width: 26,
  height: 26,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '50%',
  border: '1px solid var(--accent)',
  color: 'var(--accent)',
  background: 'var(--accent-dim)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-label)',
  fontWeight: 600,
};
const titleStyle: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-section)',
  fontWeight: 600,
  color: 'var(--text-primary)',
};

export function LaneHeader({ step, title, status }: LaneHeaderProps) {
  return (
    <div style={row}>
      <span style={badge}>{step}</span>
      <span style={titleStyle}>{title}</span>
      {status != null && <span style={{ marginLeft: 'auto' }}>{status}</span>}
    </div>
  );
}
