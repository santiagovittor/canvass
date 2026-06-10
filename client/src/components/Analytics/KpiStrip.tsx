import type { AnalyticsPayload } from '../../lib/analyticsApi';

interface KpiStripProps {
  kpis: AnalyticsPayload['kpis'];
}

const fmt = new Intl.NumberFormat('en-US');

export function KpiStrip({ kpis }: KpiStripProps) {
  const tiles = [
    { label: 'Leads scraped', value: fmt.format(kpis.totalLeads) },
    { label: 'With email', value: fmt.format(kpis.withEmail) },
    { label: 'Email yield', value: `${kpis.emailYieldPct}%` },
    { label: 'Contacted', value: fmt.format(kpis.contacted) },
    { label: 'Open rate', value: `${kpis.openRatePct}%` },
    { label: 'Response rate', value: `${kpis.responseRatePct}%` },
    { label: 'Streak', value: `${kpis.currentStreak}d` },
  ];

  return (
    <div className="an-kpi-strip">
      {tiles.map(t => (
        <div key={t.label} className="an-kpi">
          <span className="an-kpi-value">{t.value}</span>
          <span className="an-kpi-label">{t.label}</span>
        </div>
      ))}
    </div>
  );
}
