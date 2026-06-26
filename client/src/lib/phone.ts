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

// Argentina mobile E.164 (slice 0042). wa.me click-to-chat requires +54 9 <area>
// <subscriber>. Google Maps stores AR phones in local form "0<area> <rest>", where
// a mobile carries a space-delimited "15" trunk after the area code
// ("011 15-6735-8543"), landlines do not ("011 4725-3813"), and bare CABA numbers
// omit the area code ("4776-3889"). The space delimits area from rest, so the "15"
// is locatable without an area-code map; stripping the trunk 0 and the 15 always
// yields a 10-digit national number. We prepend the mobile 9 for every AR number
// (most small businesses run WhatsApp on mobile); landlines won't resolve on wa.me
// but the tel: link covers them.
// ponytail: heuristic, not libphonenumber-js — the sampled real data has no
// ambiguous 15/area formats. Swap in the library only if live yield shows mis-parses.
function arMobileE164(phone: string): string {
  const trimmed = phone.trim();
  const spaceIdx = trimmed.indexOf(' ');
  let area: string;
  let rest: string;
  if (spaceIdx > 0) {
    area = trimmed.slice(0, spaceIdx).replace(/\D/g, '').replace(/^0+/, '');
    rest = trimmed.slice(spaceIdx + 1).replace(/\D/g, '');
  } else {
    area = '11'; // bare number → assume CABA (area code 11)
    rest = trimmed.replace(/\D/g, '');
  }
  if (rest.startsWith('15')) rest = rest.slice(2); // drop the mobile trunk
  return '549' + area + rest;
}

// Best-effort E.164 (digits only, no '+'). Strips non-digits, drops a leading
// trunk '0', and prefixes the country calling code if not already present. AR is
// special-cased to the mobile form (see arMobileE164) so wa.me resolves; a tel:
// fallback is always surfaced too for landlines that won't.
export function toE164(phone: string | null, locCountry: string | null): string {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  const code = CALLING_CODE[(locCountry ?? '').trim().toLowerCase()] ?? '';
  if (!code) return digits;
  if (digits.startsWith(code)) return digits;
  if (code === '54') return arMobileE164(phone);
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
