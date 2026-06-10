interface InsightCardsProps {
  insights: { title: string; body: string }[];
}

export function InsightCards({ insights }: InsightCardsProps) {
  return (
    <div className="an-card">
      <h2 className="an-card-title">Where to aim next</h2>
      <div className="an-insights">
        {insights.map(insight => (
          <div key={insight.title} className="an-insight">
            <span className="an-insight-title">{insight.title}</span>
            <p className="an-insight-body">{insight.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
