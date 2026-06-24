import { PrepareLane } from './PrepareLane';

// Automate tab — the lead pipeline as a full-width vertical narrative:
// ① Ingest (scrape schedules) → ② Prepare (stage + run batch) → ③ Send (review +
// schedule/send). Lanes are added as they're built; Prepare is the centerpiece.
export function AutomatePage() {
  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-base)' }}>
      <div style={{
        maxWidth: 'var(--automate-max)',
        margin: '0 auto',
        padding: 'var(--space-lane)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--gap-lane)',
      }}>
        <PrepareLane />
      </div>
    </div>
  );
}
