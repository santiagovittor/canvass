import {
  getKpiCounts,
  getDailySends,
  getGeoPoints,
  getCategoryZoneMatrix,
  getEmailFoundMatrix,
  getResponseMatrix,
  getOpenStats,
  GeoPoint,
  MatrixRow,
} from '../db/analytics';
import { todayUtcMinus3 } from '../util/time';

export interface AnalyticsPayload {
  kpis: {
    totalLeads: number;
    withEmail: number;
    emailYieldPct: number;
    contacted: number;
    trackedSends: number;
    openRatePct: number;
    responseRatePct: number;
    currentStreak: number;
  };
  calendar: {
    days: { date: string; count: number }[];
    currentStreak: number;
    longestStreak: number;
    weeklyAvg: number;
  };
  funnel: {
    scraped: number;
    hasEmail: number;
    contacted: number;
    replied: number;
  };
  points: GeoPoint[];
  matrix: MatrixRow[];
  insights: { title: string; body: string }[];
}

function addDays(isoDay: string, delta: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function computeStreaks(sendDays: Set<string>, today: string): { current: number; longest: number } {
  // Current streak: consecutive days ending today, or ending yesterday if
  // nothing was sent yet today (an in-progress day doesn't break the streak).
  let current = 0;
  let cursor = sendDays.has(today) ? today : addDays(today, -1);
  while (sendDays.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  for (const day of sendDays) {
    if (sendDays.has(addDays(day, -1))) continue; // not a streak start
    let len = 1;
    let next = addDays(day, 1);
    while (sendDays.has(next)) {
      len++;
      next = addDays(next, 1);
    }
    if (len > longest) longest = len;
  }

  return { current, longest };
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

// Opportunity-oriented insights (slice 0039). Headline signals are windowed so
// they actually move as you scrape/send: response rate (the trust signal:
// reply tracking is reliable, open tracking is not until slice 0040) over 90
// days, email-found rate over 30 days with a delta vs the prior 30. Every rate
// is confidence-gated on its denominator, no headline % over a tiny sample.
function buildInsights(matrix: MatrixRow[], readyLeads: number): { title: string; body: string }[] {
  const insights: { title: string; body: string }[] = [];
  const today = todayUtcMinus3();
  const since30 = addDays(today, -30);
  const since60 = addDays(today, -60);
  const since90 = addDays(today, -90);

  // 1. Best response-rate combo over the last 90 days (sends >= 10 to be a
  //    trustworthy rate). This is the headline opportunity signal.
  const resp90 = getResponseMatrix(since90);
  const respCombos = resp90.filter(r => r.sends >= 10);
  if (respCombos.length > 0) {
    const best = respCombos.reduce((a, b) => (pct(b.replies, b.sends) > pct(a.replies, a.sends) ? b : a));
    const rate = pct(best.replies, best.sends);
    if (rate > 0) {
      insights.push({
        title: 'Best response',
        body: `${best.category} in ${best.zone}: ${rate}% reply rate (${best.replies}/${best.sends} sent, last 90 days). Your strongest combo; send more here.`,
      });
    }
  }

  // 2. Weak spot: a combo with real volume and zero replies. Reconsider or pause.
  const weak = resp90
    .filter(r => r.sends >= 15 && r.replies === 0)
    .sort((a, b) => b.sends - a.sends)[0];
  if (weak) {
    insights.push({
      title: 'Weak spot',
      body: `${weak.category} in ${weak.zone}: 0 replies on ${weak.sends} sent (last 90 days). Reconsider the angle or pause this combo.`,
    });
  }

  // 3. Best email-found combo over the last 30 days, with a delta vs the prior
  //    30. This is the box that looked frozen on all-time totals; windowed, a
  //    recent scrape moves it.
  const found30 = getEmailFoundMatrix(since30);
  const foundPrior = getEmailFoundMatrix(since60, since30);
  const found30Combos = found30.filter(r => r.leads >= 10);
  if (found30Combos.length > 0) {
    const best = found30Combos.reduce((a, b) => (pct(b.withEmail, b.leads) > pct(a.withEmail, a.leads) ? b : a));
    const rate = pct(best.withEmail, best.leads);
    let body = `${best.category} in ${best.zone}: ${rate}% have email (${best.withEmail}/${best.leads}, last 30 days).`;
    const prior = foundPrior.find(r => r.category === best.category && r.zone === best.zone);
    if (prior && prior.leads >= 5) {
      const delta = Math.round((rate - pct(prior.withEmail, prior.leads)) * 10) / 10;
      if (delta !== 0) body += ` ${delta > 0 ? 'Up' : 'Down'} ${Math.abs(delta)}pts vs prior 30 days.`;
    }
    body += ' Scrape more like this.';
    insights.push({ title: 'Recent email yield', body });
  }

  // 4. Under-scraped zone: strong all-time yield but thin coverage. Stable
  //    signal, so all-time is fine here.
  const zoneAgg = new Map<string, { leads: number; withEmail: number }>();
  for (const r of matrix) {
    const z = zoneAgg.get(r.zone) ?? { leads: 0, withEmail: 0 };
    z.leads += r.leads;
    z.withEmail += r.withEmail;
    zoneAgg.set(r.zone, z);
  }
  const thin = Array.from(zoneAgg.entries())
    .filter(([, z]) => z.leads >= 5 && z.leads < 30 && pct(z.withEmail, z.leads) >= 40)
    .sort((a, b) => pct(b[1].withEmail, b[1].leads) - pct(a[1].withEmail, a[1].leads))[0];
  if (thin) {
    insights.push({
      title: 'Under-scraped zone',
      body: `${thin[0]} yields ${pct(thin[1].withEmail, thin[1].leads)}% emails but you only have ${thin[1].leads} leads there. Scrape it next.`,
    });
  }

  // 5. Untouched pipeline
  if (readyLeads > 0) {
    insights.push({
      title: 'Ready to contact',
      body: `${readyLeads} leads with emails are still uncontacted. At 30 sends/day that's ${Math.ceil(readyLeads / 30)} days of outreach already in the pipe.`,
    });
  }

  if (insights.length === 0) {
    insights.push({
      title: 'Not enough data yet',
      body: 'Scrape a few areas and send some emails. Insights appear once there is real volume to analyze.',
    });
  }

  return insights.slice(0, 5);
}

export function getAnalytics(): AnalyticsPayload {
  const kpis = getKpiCounts();
  const openStats = getOpenStats();
  const dailySends = getDailySends();
  const today = todayUtcMinus3();

  const sendDaySet = new Set(dailySends.map(d => d.day));
  const { current, longest } = computeStreaks(sendDaySet, today);

  const countByDay = new Map(dailySends.map(d => [d.day, d.n]));
  const days: { date: string; count: number }[] = [];
  for (let i = 89; i >= 0; i--) {
    const date = addDays(today, -i);
    days.push({ date, count: countByDay.get(date) ?? 0 });
  }
  const last90Total = days.reduce((s, d) => s + d.count, 0);
  const weeklyAvg = Math.round((last90Total / (90 / 7)) * 10) / 10;

  const matrix = getCategoryZoneMatrix();

  return {
    kpis: {
      totalLeads: kpis.totalLeads,
      withEmail: kpis.withEmail,
      emailYieldPct: pct(kpis.withEmail, kpis.totalLeads),
      contacted: kpis.contactedAll,
      // trackedSends lets the UI tell "0% of N tracked" from "no tracking at all"
      // (PUBLIC_URL unset → 0 pixels → openRatePct is a meaningless constant, not a measurement).
      trackedSends: openStats.trackedSends,
      openRatePct: pct(openStats.openedSends, openStats.trackedSends),
      responseRatePct: pct(kpis.replied, kpis.contactedAll),
      currentStreak: current,
    },
    calendar: { days, currentStreak: current, longestStreak: longest, weeklyAvg },
    funnel: {
      scraped: kpis.totalLeads,
      hasEmail: kpis.withEmail,
      contacted: kpis.contactedAll,
      replied: kpis.replied,
    },
    points: getGeoPoints(),
    matrix,
    insights: buildInsights(matrix, kpis.readyLeads),
  };
}
