import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, deleteDraft, getBusinessForEmail, getDraft, saveDraftTopGap, saveDraftVerification, sqlite, upsertDraft } from '../db';
import { businesses } from '../db/schema';
import { createPremiumAnalysisRunning, getLatestPremiumAnalysis } from '../db/premium';
import type { DetectedSig, Signal, SignalMap } from '../db/premium';
import type { PsiData } from '../db/psiCache';
import { runPremiumAnalysis } from '../services/premiumAnalyzer';
import { composeVerifiedEmail } from '../services/outreachComposePipeline';
import { rankAnchors } from '../services/anchorRanker';
import { evaluateSendGate } from '../services/sendGate';
import type { VisionResult } from '../services/visionClient';

type Label = 'pixel-no-assistant' | 'pixel-with-assistant' | 'no-pixel' | 'interaction-gated';

interface Target {
  label: Label;
  input: string;
}

interface Row {
  site: string;
  pixel: string;
  assistant: string;
  anchor: string;
  disposition: string;
}

function parseArgs(): Target[] {
  const labels: Label[] = ['pixel-no-assistant', 'pixel-with-assistant', 'no-pixel', 'interaction-gated'];
  return labels.flatMap(label => {
    const prefix = `--${label}=`;
    const raw = process.argv.find(arg => arg.startsWith(prefix));
    return raw ? [{ label, input: raw.slice(prefix.length) }] : [];
  });
}

function isLikelyUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || /\.[a-z]{2,}(?:\/|$)/i.test(input);
}

function seedBusiness(url: string, label: Label): string {
  const id = `meta-pixel-gate-${label}-${randomUUID()}`;
  sqlite.prepare(`
    INSERT INTO businesses (id, job_id, name, website, emails_json, loc_country, category, scraped_at)
    VALUES (?, 'meta-pixel-gate', ?, ?, '["dryrun@example.test"]', 'United States', 'local business', ?)
  `).run(id, `Meta Pixel Gate ${label}`, url, new Date().toISOString());
  return id;
}

function signalSummary(signal: Signal | undefined): string {
  if (!signal) return 'missing';
  const evidence = signal.evidence?.value ? ` ${signal.evidence.value}` : '';
  return `${signal.state}${evidence}`;
}

async function analyzeAndCompose(target: Target): Promise<{ row: Row; syntheticId: string | null }> {
  const existing = db.select({ id: businesses.id, website: businesses.website })
    .from(businesses)
    .where(eq(businesses.id, target.input))
    .get();
  const syntheticId = existing || !isLikelyUrl(target.input) ? null : seedBusiness(target.input, target.label);
  const businessId = existing?.id ?? syntheticId ?? target.input;
  const business = getBusinessForEmail(businessId);
  if (!business) throw new Error(`Business not found and input is not a URL: ${target.input}`);

  const previousDraft = getDraft(businessId);
  try {
    const analysisRow = createPremiumAnalysisRunning(businessId);
    await runPremiumAnalysis(analysisRow);

    const premium = getLatestPremiumAnalysis(businessId);
    const detectedSigs: DetectedSig[] | undefined = premium?.detectedSigsJson
      ? JSON.parse(premium.detectedSigsJson) as DetectedSig[]
      : undefined;
    const psiData: PsiData | null = premium?.psiJson ? JSON.parse(premium.psiJson) as PsiData : null;
    const visionResult: VisionResult | null = premium?.visionJson ? JSON.parse(premium.visionJson) as VisionResult : null;
    const signalMap: SignalMap | undefined = premium?.signalsJson ? JSON.parse(premium.signalsJson) as SignalMap : undefined;
    const anchors = rankAnchors(business, detectedSigs, psiData, visionResult, signalMap);

    const result = await composeVerifiedEmail(business, undefined, detectedSigs, psiData, visionResult, signalMap, businessId);
    upsertDraft(businessId, result.subject, result.body, true);
    saveDraftTopGap(businessId, result.topGap);
    saveDraftVerification(businessId, JSON.stringify(result.verdict));
    const gate = evaluateSendGate(getDraft(businessId));

    return {
      syntheticId,
      row: {
        site: `${target.label}: ${business.website ?? target.input}`,
        pixel: signalSummary(signalMap?.hasMetaPixel),
        assistant: signalSummary(signalMap?.hasLiveChatWidget),
        anchor: anchors[0]?.id ?? '-',
        disposition: `${result.verdict.disposition ?? result.verdict.status}${gate.allowed ? ' gate_allowed' : ` gate_held:${gate.reason}`}`,
      },
    };
  } finally {
    if (previousDraft) {
      upsertDraft(businessId, previousDraft.subject, previousDraft.body, previousDraft.isAiDraft);
      saveDraftTopGap(businessId, previousDraft.topGap);
      saveDraftVerification(businessId, previousDraft.verificationJson);
    } else {
      deleteDraft(businessId);
    }
  }
}

function printTable(rows: Row[]): void {
  console.log('\nsite | pixel state+evidence | assistant state+evidence | anchor produced? | draft disposition');
  console.log('--- | --- | --- | --- | ---');
  for (const row of rows) {
    console.log(`${row.site} | ${row.pixel} | ${row.assistant} | ${row.anchor} | ${row.disposition}`);
  }
}

async function main(): Promise<void> {
  const targets = parseArgs();
  if (targets.length === 0) {
    throw new Error('Pass one or more --pixel-no-assistant=, --pixel-with-assistant=, --no-pixel=, --interaction-gated= targets.');
  }

  const syntheticIds: string[] = [];
  const rows: Row[] = [];
  try {
    for (const target of targets) {
      console.log(`\nRunning ${target.label}: ${target.input}`);
      const result = await analyzeAndCompose(target);
      if (result.syntheticId) syntheticIds.push(result.syntheticId);
      rows.push(result.row);
      console.log(`signals: pixel=${result.row.pixel}`);
      console.log(`signals: assistant=${result.row.assistant}`);
      console.log(`anchor=${result.row.anchor} disposition=${result.row.disposition}`);
    }
  } finally {
    for (const id of syntheticIds) {
      sqlite.prepare(`DELETE FROM premium_analyses WHERE business_id = ?`).run(id);
      sqlite.prepare(`DELETE FROM businesses WHERE id = ?`).run(id);
    }
  }
  printTable(rows);
}

main().catch(err => {
  console.error('meta pixel no-assistant gate failed:', err);
  process.exit(1);
});
