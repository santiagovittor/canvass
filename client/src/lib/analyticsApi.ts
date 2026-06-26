const BASE = '/api';

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
  return res.json();
}

export interface GeoPoint { lat: number; lng: number; e: number; c: number }
export interface MatrixRow { category: string; zone: string; leads: number; withEmail: number; contacted: number; replied: number }

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

export function getAnalytics() {
  return request<AnalyticsPayload>('/analytics');
}
