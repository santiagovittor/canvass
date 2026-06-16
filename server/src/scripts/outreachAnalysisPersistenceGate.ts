import { isPersistableWebsiteAnalysis, serializeWebsiteAnalysis } from '../services/outreachAnalysis';
import type { WebsiteAnalysis } from '../services/websiteAnalyzer';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const good: WebsiteAnalysis = {
  loadedSuccessfully: true,
  hasViewportMeta: true,
  hasContactForm: false,
  hasOnlineBooking: true,
  hasWhatsappLink: false,
  hasSSL: true,
  pageTitle: 'Example site',
  metaDescription: 'A useful description',
  hasMenuOrServices: true,
  finalUrl: 'https://example.com',
};

assert(isPersistableWebsiteAnalysis(good), 'successful WebsiteAnalysis should be persistable');
assert(serializeWebsiteAnalysis(good).includes('"loadedSuccessfully":true'), 'serialized analysis should preserve fields');

assert(!isPersistableWebsiteAnalysis({ ...good, loadedSuccessfully: false }), 'failed WebsiteAnalysis should not be persistable');
assert(!isPersistableWebsiteAnalysis(null), 'null should not be persistable');
assert(!isPersistableWebsiteAnalysis({ loadedSuccessfully: true }), 'malformed analysis should not be persistable');

console.log('outreach analysis persistence gate passed');
