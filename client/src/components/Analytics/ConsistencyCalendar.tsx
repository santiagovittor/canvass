import { useMemo } from 'react';
import type { AnalyticsPayload } from '../../lib/analyticsApi';

interface ConsistencyCalendarProps {
  calendar: AnalyticsPayload['calendar'];
}

function level(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

export function ConsistencyCalendar({ calendar }: ConsistencyCalendarProps) {
  // Columns are weeks (Mon-start), rows are weekdays. Pad the first week so
  // every column has 7 cells.
  const { weeks, monthLabels } = useMemo(() => {
    const days = calendar.days;
    const first = new Date(`${days[0].date}T00:00:00Z`);
    const mondayOffset = (first.getUTCDay() + 6) % 7; // 0 if Monday
    const padded: ({ date: string; count: number } | null)[] = [
      ...Array.from({ length: mondayOffset }, () => null),
      ...days,
    ];
    const weeks: ({ date: string; count: number } | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) {
      weeks.push(padded.slice(i, i + 7));
    }
    // Month label above the first week that starts a new month
    const monthLabels: (string | null)[] = weeks.map((week, i) => {
      const firstDay = week.find(Boolean);
      if (!firstDay) return null;
      const m = monthFmt.format(new Date(`${firstDay.date}T00:00:00Z`));
      if (i === 0) return m;
      const prev = weeks[i - 1].find(Boolean);
      const prevM = prev ? monthFmt.format(new Date(`${prev.date}T00:00:00Z`)) : null;
      return m !== prevM ? m : null;
    });
    return { weeks, monthLabels };
  }, [calendar.days]);

  return (
    <div className="an-card">
      <h2 className="an-card-title">Consistency</h2>
      <div className="an-cal-scroll">
        <div className="an-cal-months">
          {monthLabels.map((m, i) => (
            <span key={i} className="an-cal-month">{m ?? ''}</span>
          ))}
        </div>
        <div className="an-cal-grid">
          {weeks.map((week, wi) => (
            <div key={wi} className="an-cal-week">
              {week.map((day, di) =>
                day ? (
                  <div
                    key={day.date}
                    className={`an-cal-cell an-cal-cell--l${level(day.count)}`}
                    title={`${dateFmt.format(new Date(`${day.date}T00:00:00Z`))} — ${day.count} ${day.count === 1 ? 'email' : 'emails'}`}
                  />
                ) : (
                  <div key={`pad-${di}`} className="an-cal-cell an-cal-cell--pad" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="an-cal-stats">
        <div className="an-cal-stat">
          <span className="mono an-cal-stat-value">{calendar.currentStreak}d</span>
          <span className="an-cal-stat-label">current streak</span>
        </div>
        <div className="an-cal-stat">
          <span className="mono an-cal-stat-value">{calendar.longestStreak}d</span>
          <span className="an-cal-stat-label">longest streak</span>
        </div>
        <div className="an-cal-stat">
          <span className="mono an-cal-stat-value">{calendar.weeklyAvg}</span>
          <span className="an-cal-stat-label">per week avg</span>
        </div>
      </div>
    </div>
  );
}
