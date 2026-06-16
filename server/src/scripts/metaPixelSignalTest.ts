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
