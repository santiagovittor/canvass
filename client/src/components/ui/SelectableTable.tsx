import type { CSSProperties, ReactNode } from 'react';
import { Checkbox } from './Checkbox';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Render the cell value in the mono/data face. */
  mono?: boolean;
  width?: number;
}

interface SelectableTableProps<T> {
  rows: T[];
  rowId: (row: T) => string;
  columns: Column<T>[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Toggles all CURRENTLY-rendered rows (passed their ids). */
  onToggleAll: (ids: string[]) => void;
  emptyLabel?: string;
}

// Generic dense selectable table — no third-party grid. Leading checkbox column
// with a tri-state select-all in the header. Selected rows get a faint accent
// tint. Compact rows (~44px) for scannable data.
const cellBase: CSSProperties = {
  padding: '0 10px',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-body)',
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const headCell: CSSProperties = {
  padding: '0 10px',
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-caption)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  textAlign: 'left',
  fontWeight: 600,
};

export function SelectableTable<T>({
  rows, rowId, columns, selected, onToggle, onToggleAll, emptyLabel = 'Sin resultados.',
}: SelectableTableProps<T>) {
  const ids = rows.map(rowId);
  const selectedHere = ids.filter(id => selected.has(id)).length;
  const allSelected = ids.length > 0 && selectedHere === ids.length;
  const someSelected = selectedHere > 0 && !allSelected;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      {/* header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `40px ${columns.map(c => (c.width ? `${c.width}px` : '1fr')).join(' ')}`,
          alignItems: 'center',
          height: 40,
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            onChange={() => onToggleAll(ids)}
            aria-label="Seleccionar todo"
          />
        </div>
        {columns.map(c => (
          <div key={c.key} style={headCell}>{c.header}</div>
        ))}
      </div>

      {/* body */}
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div style={{ padding: 18, fontFamily: 'var(--font-ui)', fontSize: 'var(--text-label)', color: 'var(--text-muted)' }}>
            {emptyLabel}
          </div>
        ) : (
          rows.map(row => {
            const id = rowId(row);
            const isSel = selected.has(id);
            return (
              <div
                key={id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `40px ${columns.map(c => (c.width ? `${c.width}px` : '1fr')).join(' ')}`,
                  alignItems: 'center',
                  height: 44,
                  borderBottom: '1px solid var(--hairline)',
                  background: isSel ? 'var(--accent-dim)' : 'transparent',
                  cursor: 'pointer',
                }}
                onClick={() => onToggle(id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
                  <Checkbox checked={isSel} onChange={() => onToggle(id)} aria-label={`Seleccionar ${id}`} />
                </div>
                {columns.map(c => (
                  <div key={c.key} style={{ ...cellBase, fontFamily: c.mono ? 'var(--font-mono)' : 'var(--font-ui)' }}>
                    {c.render(row)}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
