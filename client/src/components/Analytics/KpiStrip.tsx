import type { AnalyticsPayload } from '../../lib/analyticsApi';

interface KpiStripProps {
  kpis: AnalyticsPayload['kpis'];
}

const fmt = new Intl.NumberFormat('en-US');

export function KpiStrip({ kpis }: KpiStripProps) {
  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: 'Leads scraped', value: fmt.format(kpis.totalLeads) },
    { label: 'With email', value: fmt.format(kpis.withEmail) },
    { label: 'Email yield', value: `${kpis.emailYieldPct}%` },
    { label: 'Contacted', value: fmt.format(kpis.contacted) },
    kpis.trackedSends > 0
      ? { label: 'Open rate', value: `${kpis.openRatePct}%`, sub: '(opens can’t be confirmed)' }
      : { label: 'Open rate', value: '—', sub: 'tracking off' },
    { label: 'Response rate', value: `${kpis.responseRatePct}%`, sub: '(auto-replies excluded)' },
    { label: 'Streak', value: `${kpis.currentStreak}d` },
  ];

  return (
    <div className="an-kpi-strip">
      {tiles.map(t => (
        <div key={t.label} className="an-kpi">
          <span className="an-kpi-value">{t.value}</span>
          <span className="an-kpi-label">{t.label}</span>
          {t.sub && <span className="an-kpi-sub">{t.sub}</span>}
        </div>
      ))}
    </div>
  );
}
