export function formatRating(rating?: number): string {
  if (rating == null) return '—';
  return rating.toFixed(1);
}

export function formatCount(n?: number): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('es-AR').format(n);
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
