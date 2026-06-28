import { getBool, getNumber, resetSetting, setSetting } from '../services/appSettings';
import { rankAnchors } from '../services/anchorRanker';
import { CHAT_RX } from '../services/websiteAnalyzer';
import { SIGNATURES } from '../data/signatureLibrary';
import {
  applyVisionUpgradesForTest,
  detectSignalsForTest,
} from '../services/premiumAnalyzer';
import type { SignalMap } from '../db/premium';
import type { VisionResult } from '../services/visionClient';

function assert(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
    process.exit(1);
  }
  console.log(`OK   ${name}`);
}

function baseVision(chat: VisionResult['widgetVisibility']['chat']): VisionResult {
  return {
    strengths: [],
    opportunities: [],
    designEra: 'test',
    widgetVisibility: { whatsapp: 'no', chat, booking: 'no' },
    mobileResponsive: 'yes',
  };
}

function run(): void {
  resetSetting('META_PIXEL_ANCHOR_ENABLED');
  resetSetting('META_PIXEL_ANCHOR_PRIORITY');

  const pixelSignals = detectSignalsForTest(
    `<html><head><script>fbq('init', '1234567890');</script></head></html>`,
    ['https://connect.facebook.net/en_US/fbevents.js', 'https://www.facebook.com/tr?id=1234567890&ev=PageView'],
    'https://example.test',
  );
  assert('Meta Pixel is PRESENT from DOM/network markers', pixelSignals.hasMetaPixel?.state === 'PRESENT');
  assert(
    'Meta Pixel evidence carries markers and pixel ID',
    /network:fbevents\.js/.test(pixelSignals.hasMetaPixel?.evidence?.value ?? '') &&
      /network:facebook_tr/.test(pixelSignals.hasMetaPixel?.evidence?.value ?? '') &&
      /dom:fbq_init/.test(pixelSignals.hasMetaPixel?.evidence?.value ?? '') &&
      /pixelId=1234567890/.test(pixelSignals.hasMetaPixel?.evidence?.value ?? ''),
    pixelSignals.hasMetaPixel?.evidence?.value,
  );

  const noPixelSignals = detectSignalsForTest('<html></html>', [], 'https://example.test');
  assert('Meta Pixel absence stays UNKNOWN', noPixelSignals.hasMetaPixel?.state === 'UNKNOWN');

  // Slice 0050: Google Ads conversion + GTM detection.
  const adTechSignals = detectSignalsForTest(
    `<html><head>
       <script async src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD123"></script>
       <script>gtag('config','AW-998877665');gtag('event','conversion',{'send_to':'AW-998877665/abc'});</script>
     </head></html>`,
    ['https://www.googleadservices.com/pagead/conversion/998877665/'],
    'https://advertiser.test',
  );
  assert('Google Ads is PRESENT from AW- id + conversion endpoint', adTechSignals.hasGoogleAds?.state === 'PRESENT');
  assert(
    'Google Ads evidence carries conversion id + network marker',
    /conversionId=AW-998877665/.test(adTechSignals.hasGoogleAds?.evidence?.value ?? '') &&
      /network:googleadservices_conversion/.test(adTechSignals.hasGoogleAds?.evidence?.value ?? ''),
    adTechSignals.hasGoogleAds?.evidence?.value,
  );
  assert('GTM is PRESENT from container id + gtm.js', adTechSignals.hasGtm?.state === 'PRESENT');
  assert(
    'GTM evidence carries container id',
    /containerId=GTM-ABCD123/.test(adTechSignals.hasGtm?.evidence?.value ?? ''),
    adTechSignals.hasGtm?.evidence?.value,
  );

  // A static brochure (GA4 only, no AW- / GTM- / fbq) shows none of the ad-intent flags.
  const brochureSignals = detectSignalsForTest(
    `<html><head><script>gtag('config','G-ABCDEF1234');</script></head><body>Welcome</body></html>`,
    ['https://www.google-analytics.com/g/collect'],
    'https://brochure.test',
  );
  assert('Brochure: Google Ads stays UNKNOWN (GA4 G- is not AW-)', brochureSignals.hasGoogleAds?.state === 'UNKNOWN');
  assert('Brochure: GTM stays UNKNOWN', brochureSignals.hasGtm?.state === 'UNKNOWN');
  assert('Brochure: Meta Pixel stays UNKNOWN', brochureSignals.hasMetaPixel?.state === 'UNKNOWN');

  const absentChatSignals: SignalMap = {
    hasLiveChatWidget: { state: 'UNKNOWN', checkedBy: ['dom', 'network'] },
  };
  applyVisionUpgradesForTest(absentChatSignals, baseVision('no'), true, null);
  assert('Chat becomes ABSENT_VERIFIED only after DOM/network/vision agreement', absentChatSignals.hasLiveChatWidget?.state === 'ABSENT_VERIFIED');

  const unsureChatSignals: SignalMap = {
    hasLiveChatWidget: { state: 'UNKNOWN', checkedBy: ['dom', 'network'] },
  };
  applyVisionUpgradesForTest(unsureChatSignals, baseVision('unsure'), true, null);
  assert('Vision unsure keeps chat UNKNOWN', unsureChatSignals.hasLiveChatWidget?.state === 'UNKNOWN');

  const partialChatSignals: SignalMap = {
    hasLiveChatWidget: { state: 'UNKNOWN', checkedBy: ['dom'] },
  };
  applyVisionUpgradesForTest(partialChatSignals, baseVision('no'), true, null);
  assert('Missing network agreement keeps chat UNKNOWN', partialChatSignals.hasLiveChatWidget?.state === 'UNKNOWN');

  const anchors = rankAnchors(
    { category: 'clinic', locCountry: 'United States' },
    [],
    null,
    null,
    {
      hasMetaPixel: pixelSignals.hasMetaPixel!,
      hasLiveChatWidget: absentChatSignals.hasLiveChatWidget!,
    },
  );
  assert('Compound anchor is produced for pixel plus verified assistant absence', anchors[0]?.id === 'pixel_no_assistant');
  assert('Compound anchor evidence references both legs', anchors[0]?.evidenceRef === 'signal.hasMetaPixel=PRESENT;signal.hasLiveChatWidget=ABSENT_VERIFIED');
  assert('Compound anchor priority comes from settings default', anchors[0]?.priority === getNumber('META_PIXEL_ANCHOR_PRIORITY'));

  const noAssistantOnly = rankAnchors(
    { category: 'clinic', locCountry: 'United States' },
    [],
    null,
    null,
    { hasLiveChatWidget: absentChatSignals.hasLiveChatWidget! },
  );
  assert('Chat absence is not ranked as a standalone generic anchor', noAssistantOnly.every(a => a.id !== 'absent_hasLiveChatWidget'));

  setSetting('META_PIXEL_ANCHOR_ENABLED', false);
  assert('Boolean setting writes through settings accessor', getBool('META_PIXEL_ANCHOR_ENABLED') === false);
  const disabledAnchors = rankAnchors(
    { category: 'clinic', locCountry: 'United States' },
    [],
    null,
    null,
    {
      hasMetaPixel: pixelSignals.hasMetaPixel!,
      hasLiveChatWidget: absentChatSignals.hasLiveChatWidget!,
    },
  );
  assert('Disabled setting suppresses compound anchor', disabledAnchors.every(a => a.id !== 'pixel_no_assistant'));
  resetSetting('META_PIXEL_ANCHOR_ENABLED');

  const chatVendors = [
    'drift.com',
    'static.olark.com',
    'cdn.livechatinc.com',
    'wchat.freshchat.com',
    'code.jivosite.com',
    'manychat.com',
    'fb-customerchat',
    'xfbml.customerchat.js',
  ];
  for (const vendor of chatVendors) {
    assert(`CHAT_RX detects ${vendor}`, CHAT_RX.test(vendor));
  }
  const sigIds = new Set(SIGNATURES.filter(s => s.signalKey === 'hasLiveChatWidget').map(s => s.id));
  for (const id of ['drift', 'olark', 'livechat', 'freshchat', 'jivochat', 'manychat', 'facebook-customer-chat']) {
    assert(`signature library includes ${id}`, sigIds.has(id));
  }
}

run();
