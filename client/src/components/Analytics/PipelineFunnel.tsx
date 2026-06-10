import type { AnalyticsPayload } from '../../lib/analyticsApi';

interface PipelineFunnelProps {
  funnel: AnalyticsPayload['funnel'];
}

const fmt = new Intl.NumberFormat('en-US');

export function PipelineFunnel({ funnel }: PipelineFunnelProps) {
  const stages = [
    { label: 'Scraped', value: funnel.scraped },
    { label: 'Has email', value: funnel.hasEmail },
    { label: 'Contacted', value: funnel.contacted },
    { label: 'Replied', value: funnel.replied },
  ];
  const max = stages[0].value || 1;

  return (
    <div className="an-card">
      <h2 className="an-card-title">Pipeline</h2>
      <div className="an-funnel">
        {stages.map((stage, i) => {
          const conv = i > 0 && stages[i - 1].value > 0
            ? Math.round((stage.value / stages[i - 1].value) * 1000) / 10
            : null;
          return (
            <div key={stage.label} className="an-funnel-stage">
              {conv !== null && (
                <div className="an-funnel-conv">
                  <span className="mono an-funnel-conv-pct">{conv}%</span>
                  <span className="an-funnel-conv-label">convert · {Math.round((100 - conv) * 10) / 10}% drop</span>
                </div>
              )}
              <div className="an-funnel-row">
                <span className="an-funnel-label">{stage.label}</span>
                <span className="mono an-funnel-value">{fmt.format(stage.value)}</span>
              </div>
              <div className="an-funnel-track">
                <div
                  className="an-funnel-fill"
                  style={{ width: `${Math.max((stage.value / max) * 100, stage.value > 0 ? 1.5 : 0)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
