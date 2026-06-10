import { useAnalytics } from '../hooks/useAnalytics';
import { KpiStrip } from '../components/Analytics/KpiStrip';
import { ConsistencyCalendar } from '../components/Analytics/ConsistencyCalendar';
import { PipelineFunnel } from '../components/Analytics/PipelineFunnel';
import { GeoHexMap } from '../components/Analytics/GeoHexMap';
import { CategoryMatrix } from '../components/Analytics/CategoryMatrix';
import { InsightCards } from '../components/Analytics/InsightCards';

export function Analytics() {
  const { data, error, loading, reload } = useAnalytics();

  if (loading) {
    return (
      <div className="an-page">
        <div className="an-kpi-strip">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="an-kpi an-skeleton" />
          ))}
        </div>
        <div className="an-bento">
          <div className="an-card an-card--map an-skeleton" />
          <div className="an-bento-side">
            <div className="an-card an-skeleton" style={{ minHeight: '200px' }} />
            <div className="an-card an-skeleton" style={{ minHeight: '200px' }} />
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="an-page">
        <div className="an-card an-error">
          <p>{error ?? 'No data'}</p>
          <button className="btn-secondary" onClick={reload}>Retry loading</button>
        </div>
      </div>
    );
  }

  return (
    <div className="an-page">
      <KpiStrip kpis={data.kpis} />
      <div className="an-bento">
        <GeoHexMap points={data.points} />
        <div className="an-bento-side">
          <PipelineFunnel funnel={data.funnel} />
          <ConsistencyCalendar calendar={data.calendar} />
        </div>
      </div>
      <div className="an-bento an-bento--lower">
        <CategoryMatrix matrix={data.matrix} />
        <InsightCards insights={data.insights} />
      </div>
    </div>
  );
}
