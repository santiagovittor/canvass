import { useMemo, useState } from 'react';
import type { MatrixRow } from '../../lib/analyticsApi';

interface CategoryMatrixProps {
  matrix: MatrixRow[];
}

const MAX_CATEGORIES = 12;
const MAX_ZONES = 8;
const MIN_CELL_LEADS = 5; // below this, yield % is noise
const MIN_TOP_LEADS = 8;

interface Cell { leads: number; withEmail: number }

function yieldPct(c: Cell): number {
  return c.leads > 0 ? Math.round((c.withEmail / c.leads) * 100) : 0;
}

export function CategoryMatrix({ matrix }: CategoryMatrixProps) {
  // sortKey: 'total' or a zone name; always descending
  const [sortKey, setSortKey] = useState<string>('total');

  const { categories, zones, cells, top3 } = useMemo(() => {
    const zoneTotals = new Map<string, number>();
    const catTotals = new Map<string, number>();
    const cells = new Map<string, Cell>(); // "category|zone"
    for (const r of matrix) {
      zoneTotals.set(r.zone, (zoneTotals.get(r.zone) ?? 0) + r.leads);
      catTotals.set(r.category, (catTotals.get(r.category) ?? 0) + r.leads);
      cells.set(`${r.category}|${r.zone}`, { leads: r.leads, withEmail: r.withEmail });
    }
    const zones = Array.from(zoneTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ZONES)
      .map(([z]) => z);
    const categories = Array.from(catTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CATEGORIES)
      .map(([c, total]) => ({ category: c, total }));

    const visible = matrix.filter(
      r => r.leads >= MIN_TOP_LEADS && zones.includes(r.zone) && categories.some(c => c.category === r.category),
    );
    const top3 = new Set(
      visible
        .sort((a, b) => yieldPct(b) - yieldPct(a))
        .slice(0, 3)
        .map(r => `${r.category}|${r.zone}`),
    );

    return { categories, zones, cells, top3 };
  }, [matrix]);

  const sortedCategories = useMemo(() => {
    const arr = [...categories];
    if (sortKey === 'total') {
      arr.sort((a, b) => b.total - a.total);
    } else {
      arr.sort((a, b) => {
        const ca = cells.get(`${a.category}|${sortKey}`);
        const cb = cells.get(`${b.category}|${sortKey}`);
        return (cb ? yieldPct(cb) : -1) - (ca ? yieldPct(ca) : -1);
      });
    }
    return arr;
  }, [categories, cells, sortKey]);

  if (matrix.length === 0) {
    return (
      <div className="an-card">
        <h2 className="an-card-title">Category × zone yield</h2>
        <div className="an-empty">No zoned leads yet. Zones appear once location enrichment has run.</div>
      </div>
    );
  }

  return (
    <div className="an-card">
      <h2 className="an-card-title">Category × zone yield</h2>
      <p className="an-card-sub">Email yield % per combination. Top 3 marked. Click a column to sort.</p>
      <div className="an-matrix-scroll">
        <table className="an-matrix">
          <thead>
            <tr>
              <th
                className={`an-matrix-cat-th${sortKey === 'total' ? ' an-matrix-th--sorted' : ''}`}
                onClick={() => setSortKey('total')}
              >
                Category
              </th>
              <th
                className={`an-matrix-num-th${sortKey === 'total' ? ' an-matrix-th--sorted' : ''}`}
                onClick={() => setSortKey('total')}
              >
                Leads
              </th>
              {zones.map(z => (
                <th
                  key={z}
                  className={`an-matrix-zone-th${sortKey === z ? ' an-matrix-th--sorted' : ''}`}
                  onClick={() => setSortKey(z)}
                  title={z}
                >
                  {z}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedCategories.map(({ category, total }) => (
              <tr key={category}>
                <td className="an-matrix-cat" title={category}>{category}</td>
                <td className="mono an-matrix-total">{total}</td>
                {zones.map(z => {
                  const cell = cells.get(`${category}|${z}`);
                  if (!cell || cell.leads < MIN_CELL_LEADS) {
                    return <td key={z} className="an-matrix-cell an-matrix-cell--empty">·</td>;
                  }
                  const pct = yieldPct(cell);
                  const isTop = top3.has(`${category}|${z}`);
                  return (
                    <td
                      key={z}
                      className={`mono an-matrix-cell${isTop ? ' an-matrix-cell--top' : ''}`}
                      style={{ backgroundColor: `rgba(232, 147, 10, ${0.04 + (pct / 100) * 0.4})` }}
                      title={`${category} × ${z}: ${cell.withEmail}/${cell.leads} emails`}
                    >
                      {pct}%
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
