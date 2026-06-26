// Pre-run lead estimate (slice 0038). Rough band of how many leads a single
// B2B-category sweep of a city of this population tends to return.
//
// ponytail: flat per-capita constant — the calibration knob. ~1 lead per 1000
// residents for one category, ±50% band. Tune once real per-cell yields land
// (cross-ref slice 0039 analytics); a population-weighted model is parked.
const LEADS_PER_CAPITA = 1 / 1000;

export interface LeadEstimate { lo: number; hi: number; }

export function estimateLeads(population: number): LeadEstimate | null {
  if (!population || population <= 0) return null;
  const mid = population * LEADS_PER_CAPITA;
  return {
    lo: Math.max(1, Math.round(mid * 0.5)),
    hi: Math.max(1, Math.round(mid * 1.5)),
  };
}
