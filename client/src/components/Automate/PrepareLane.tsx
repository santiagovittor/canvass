import { useState, useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { useBatchRun } from '../../hooks/useBatchRun';
import { useLeadStaging, type StagingLead } from '../../hooks/useLeadStaging';
import { getBatch, type BatchItem } from '../../lib/batchApi';
import { countryFlag } from '../../lib/outreachApi';
import { SelectableTable, type Column } from '../ui/SelectableTable';
import { LaneHeader } from './LaneHeader';
import { BatchRunView } from './BatchConsole';

// Prepare lane: stage deliverable leads with a checklist, run the batch over the
// selected ids, then watch the live run. Idle shows the staging table + controls;
// while a run is active it shows the BatchRunView.

const PRESETS = [15, 30, 60];

const pill: CSSProperties = {
  background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 20,
  padding: '6px 14px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-label)',
  color: 'var(--text-secondary)', cursor: 'pointer',
};
const searchInput: CSSProperties = {
  flex: 1, minWidth: 180, background: 'var(--bg-panel)', border: '1px solid var(--border-strong)',
  borderRadius: 8, padding: '8px 12px', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-body)',
  color: 'var(--text-primary)', outline: 'none',
};

const COLUMNS: Column<StagingLead>[] = [
  { key: 'name', header: 'Negocio', render: l => l.name },
  { key: 'category', header: 'Categoría', render: l => l.category ?? '—', width: 200 },
  { key: 'country', header: 'País', render: l => `${countryFlag(l.locCountry)} ${l.locCountry ?? '—'}`, width: 150 },
];

export function PrepareLane() {
  const { progress, currentLeadId, accumulatedCost, start, pause, resume, cancel, error } = useBatchRun();
  const staging = useLeadStaging();
  const [dryRun, setDryRun] = useState(true);
  const [items, setItems] = useState<BatchItem[]>([]);

  const status = progress?.status ?? null;
  const active = status === 'running' || status === 'paused';
  const runId = progress?.runId ?? null;

  // Per-lead outcomes — refetched when the run changes or advances (event-driven
  // off SSE-updated progress, not a poll).
  useEffect(() => {
    if (!runId) { setItems([]); return; }
    getBatch(runId).then(r => setItems(r.items)).catch(() => {});
  }, [runId, progress?.processed, progress?.status]);

  const currentItem = currentLeadId ? items.find(i => i.businessId === currentLeadId) : undefined;
  const currentLead = currentLeadId
    ? { id: currentLeadId, name: currentItem?.name ?? null, locCountry: currentItem?.locCountry ?? null }
    : null;

  const handleRun = useCallback(() => {
    if (staging.selected.size === 0) return;
    start([...staging.selected], dryRun);
  }, [staging.selected, dryRun, start]);

  return (
    <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pane)', padding: 'var(--space-lane)' }}>
      <LaneHeader
        step={2}
        title="Preparar"
        status={!active && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-label)', color: 'var(--text-muted)' }}>
            {staging.total} elegibles · {staging.selected.size} seleccionados
          </span>
        )}
      />

      {active && progress ? (
        <BatchRunView
          progress={progress}
          currentLead={currentLead}
          accumulatedCost={accumulatedCost}
          items={items}
          onPause={pause}
          onResume={resume}
          onCancel={cancel}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* search + quick-select */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={staging.search}
              onChange={e => staging.setSearch(e.target.value)}
              placeholder="Buscar negocio…"
              aria-label="Buscar leads"
              style={searchInput}
            />
            {PRESETS.map(n => (
              <button key={n} style={pill} onClick={() => staging.selectFirst(n)}>Primeros {n}</button>
            ))}
            {staging.selected.size > 0 && (
              <button style={pill} onClick={staging.clear}>Limpiar</button>
            )}
          </div>

          <SelectableTable
            rows={staging.leads}
            rowId={l => l.id}
            columns={COLUMNS}
            selected={staging.selected}
            onToggle={staging.toggle}
            onToggleAll={staging.toggleAll}
            emptyLabel={staging.loading ? 'Cargando leads…' : 'No hay leads elegibles.'}
          />

          {error && (
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-label)', color: 'var(--error)' }}>{error}</span>
          )}

          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-body)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
              Dry-run (preparar + encolar, sin envío real)
            </label>
            <button
              className="btn-primary"
              disabled={staging.selected.size === 0}
              onClick={handleRun}
              style={{ marginLeft: 'auto' }}
            >
              Preparar {staging.selected.size} seleccionado{staging.selected.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
