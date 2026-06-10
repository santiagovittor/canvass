import {
  getKpiCounts,
  getDailySends,
  getRepliedSendDays,
  getGeoPoints,
  getCategoryZoneMatrix,
  getCategoryYields,
  getBandYields,
  getOpenStats,
  GeoPoint,
  MatrixRow,
} from '../db/analytics';

export interface AnalyticsPayload {
  kpis: {
    totalLeads: number;
    withEmail: number;
    emailYieldPct: number;
    contacted: number;
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

// Matches todayUtcMinus3() in db/index.ts — sent_at day boundaries are UTC-3.
function todayUtcMinus3(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(isoDay: string, delta: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(isoDay: string): number {
  return new Date(`${isoDay}T00:00:00Z`).getUTCDay(); // 0 = Sunday
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

function buildInsights(
  matrix: MatrixRow[],
  dailySends: { day: string; n: number }[],
  repliedDays: { day: string; n: number }[],
  readyLeads: number,
): { title: string; body: string }[] {
  const insights: { title: string; body: string }[] = [];

  // 1. Best category × zone combination + an unscraped suggestion there
  const combos = matrix.filter(r => r.leads >= 10);
  if (combos.length > 0) {
    const best = combos.reduce((a, b) => (pct(b.withEmail, b.leads) > pct(a.withEmail, a.leads) ? b : a));
    const bestYield = pct(best.withEmail, best.leads);
    const categoriesInZone = new Set(matrix.filter(r => r.zone === best.zone).map(r => r.category));
    const catYields = getCategoryYields().filter(c => c.leads >= 20 && pct(c.withEmail, c.leads) >= 40);
    const suggestion = catYields
      .filter(c => !categoriesInZone.has(c.category))
      .sort((a, b) => pct(b.withEmail, b.leads) - pct(a.withEmail, a.leads))[0];
    let body = `${best.category} in ${best.zone} yields ${bestYield}% emails (${best.withEmail}/${best.leads}) — your best combination.`;
    if (suggestion) {
      body += ` You haven't scraped ${suggestion.category} there yet; it yields ${pct(suggestion.withEmail, suggestion.leads)}% overall.`;
    }
    insights.push({ title: 'Best combination', body });
  }

  // 2. Rating / review-count band with the highest email yield
  const bands = getBandYields().filter(b => b.leads >= 15);
  if (bands.length >= 2) {
    const best = bands.reduce((a, b) => (pct(b.withEmail, b.leads) > pct(a.withEmail, a.leads) ? b : a));
    insights.push({
      title: 'Highest-yield profile',
      body: `Leads rated ${best.ratingBand} with ${best.reviewBand} reviews have your highest email yield: ${pct(best.withEmail, best.leads)}% across ${best.leads} leads.`,
    });
  }

  // 3. Day-of-week sending pattern + response rate
  const totalSends = dailySends.reduce((s, d) => s + d.n, 0);
  if (totalSends >= 10) {
    const sendsByDow = new Array(7).fill(0);
    const repliesByDow = new Array(7).fill(0);
    for (const d of dailySends) sendsByDow[weekdayOf(d.day)] += d.n;
    for (const d of repliedDays) repliesByDow[weekdayOf(d.day)] += d.n;

    const unused = WEEKDAY_NAMES.filter((_, i) => sendsByDow[i] === 0);
    let bestDow = -1;
    let bestRate = 0;
    for (let i = 0; i < 7; i++) {
      if (sendsByDow[i] < 5) continue;
      const rate = repliesByDow[i] / sendsByDow[i];
      if (rate > bestRate) { bestRate = rate; bestDow = i; }
    }
    const parts: string[] = [];
    if (unused.length > 0 && unused.length <= 3) {
      parts.push(`You've sent 0 emails on ${unused.join(' and ')}s.`);
    }
    if (bestDow >= 0 && bestRate > 0) {
      parts.push(`Your response rate is highest on ${WEEKDAY_NAMES[bestDow]}s (${Math.round(bestRate * 100)}% of ${sendsByDow[bestDow]} sends).`);
    }
    if (parts.length > 0) {
      insights.push({ title: 'Sending pattern', body: parts.join(' ') });
    }
  }

  // 4. Under-scraped zone: strong yield but thin coverage
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
      body: 'Scrape a few areas and send some emails — insights appear once there is real volume to analyze.',
    });
  }

  return insights.slice(0, 5);
}

export function getAnalytics(): AnalyticsPayload {
  const kpis = getKpiCounts();
  const openStats = getOpenStats();
  const dailySends = getDailySends();
  const repliedDays = getRepliedSendDays();
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
    insights: buildInsights(matrix, dailySends, repliedDays, kpis.readyLeads),
  };
}
