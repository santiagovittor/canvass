import type { WebsiteAnalysis } from './websiteAnalyzer';

const REQUIRED_BOOLEAN_KEYS = [
  'loadedSuccessfully',
  'hasViewportMeta',
  'hasContactForm',
  'hasOnlineBooking',
  'hasWhatsappLink',
  'hasSSL',
  'hasMenuOrServices',
] as const;

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

export function isPersistableWebsiteAnalysis(value: unknown): value is WebsiteAnalysis {
  if (!value || typeof value !== 'object') return false;
  const analysis = value as Record<string, unknown>;
  if (analysis.loadedSuccessfully !== true) return false;
  if (!REQUIRED_BOOLEAN_KEYS.every(key => typeof analysis[key] === 'boolean')) return false;
  return isNullableString(analysis.pageTitle)
    && isNullableString(analysis.metaDescription)
    && isNullableString(analysis.finalUrl);
}

export function serializeWebsiteAnalysis(analysis: WebsiteAnalysis): string {
  return JSON.stringify(analysis);
}
