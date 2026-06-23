// Phone → click-to-contact links for the no-website lane (slice 0007).
// Pure functions, no React. Google Maps stores phones in local format
// (e.g. "011 4740-4093" for Argentina), so we best-effort normalize to E.164.

// Calling code per country the scraper actually returns (AR 95%, US, ES).
const CALLING_CODE: Record<string, string> = {
  argentina: '54',
  'united states': '1',
  usa: '1',
  spain: '34',
  'españa': '34',
  espana: '34',
};

// Best-effort E.164 (digits only, no '+'). Strips non-digits, drops a leading
// trunk '0', and prefixes the country calling code if not already present.
// Note: AR mobile vs landline can't be told apart from the stored field, so we
// do NOT insert the AR mobile '9' — wa.me may not resolve for landlines, which
// is why a tel: fallback is always surfaced too.
export function toE164(phone: string | null, locCountry: string | null): string {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  const code = CALLING_CODE[(locCountry ?? '').trim().toLowerCase()] ?? '';
  if (!code) return digits;
  if (digits.startsWith(code)) return digits;
  digits = digits.replace(/^0+/, '');
  return code + digits;
}

// https://wa.me/<e164>?text=<encoded> — opens WhatsApp with the draft prefilled.
// Returns '' when no usable number, so callers can disable the affordance.
export function waLink(phone: string | null, locCountry: string | null, message: string): string {
  const e164 = toE164(phone, locCountry);
  if (!e164) return '';
  const text = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${e164}${text}`;
}

// tel: link using the raw number — the reliable fallback for landlines.
export function telLink(phone: string | null): string {
  if (!phone) return '';
  const cleaned = phone.replace(/[^\d+]/g, '');
  return cleaned ? `tel:${cleaned}` : '';
}
