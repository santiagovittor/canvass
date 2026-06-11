// All outreach timestamps are stored UTC-3 shifted (Argentina local) so that
// ISO-string date slicing lines up with the user's calendar day.
export const UTC_MINUS_3_OFFSET_MS = 3 * 60 * 60 * 1000;

// sent_at is stored as UTC-3 shifted ISO string so that sent_at.slice(0,10)
// always equals todayUtcMinus3(). Never change one without changing the other.
export function todayUtcMinus3(): string {
  return new Date(Date.now() - UTC_MINUS_3_OFFSET_MS).toISOString().slice(0, 10);
}

export function nowUtcMinus3(): string {
  return new Date(Date.now() - UTC_MINUS_3_OFFSET_MS).toISOString();
}
