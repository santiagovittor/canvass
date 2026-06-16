/**
 * Dry-run live gate for the tone + AI-assistant-offer slice. NEVER sends (no SMTP).
 *
 * Operates on REAL leads using their already-stored premium analysis (no network
 * re-run). For each selected lead it runs the real compose → verify → repair → guard
 * pipeline (composeVerifiedEmail) and prints, per email:
 *   - anchor used (top-ranked + the one that survived verification)
 *   - declared claims + verifier verdict (supported? + evidence)
 *   - final subject/body
 *   - status / disposition / send-allowed
 *
 * Selection is automatic from stored signals, but specific leads can be forced:
 *   --gated=<businessId>      lead expected to carry the gated no-assistant hook
 *   --ungated=<businessId>    lead with chat PRESENT/UNKNOWN (must NOT claim lack)
 *   --es=<businessId> --en=<businessId>   force the language demos
 *   --funda=<businessId>      the Estudio FUN before/after lead (also auto-detected)
 *
 * Run in the dev container (Node 20):
 *   docker compose exec server sh -c "cd /app/server && npx tsx src/scripts/toneAssistantOfferGate.ts"
 */
import { randomUUID } from 'crypto';
import { sqlite, getBusinessForEmail } from '../db';
import type { BusinessForEmailRow } from '../db';
import type { DetectedSig, SignalMap } from '../db/premium';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from '../services/visionClient';
import { rankAnchors } from '../services/anchorRanker';
import { composeVerifiedEmail } from '../services/outreachComposePipeline';
import { SEND_ALLOWED_STATUSES } from '../services/geminiVerifier';

interface AnalysisRow {
  business_id: string;
  name: string;
  website: string | null;
  loc_country: string | null;
  signals_json: string | null;
  psi_json: string | null;
  vision_json: string | null;
  detected_sigs_json: string | null;
}

// Latest DONE analysis per business that has a signal map to anchor on.
const stmtLatestDone = sqlite.prepare<[], AnalysisRow>(`
  SELECT pa.business_id, b.name, b.website, b.loc_country,
         pa.signals_json, pa.psi_json, pa.vision_json, pa.detected_sigs_json
  FROM premium_analyses pa
  JOIN businesses b ON b.id = pa.business_id
  WHERE pa.status = 'done' AND pa.signals_json IS NOT NULL
  GROUP BY pa.business_id
  HAVING pa.created_at = MAX(pa.created_at)
  ORDER BY pa.created_at DESC
`);

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const raw = process.argv.find(a => a.startsWith(prefix));
  return raw?.slice(prefix.length);
}

function parseSignals(json: string | null): SignalMap | undefined {
  return json ? (JSON.parse(json) as SignalMap) : undefined;
}

// EN demo fallback: no non-AR lead has a stored analysis, so clone a real source
// analysis (its genuine signals/psi/vision) under a temporary US-locale business to
// exercise the English compose+verify path on real evidence. Self-cleaning.
function synthesizeEnLead(src: AnalysisRow): { row: AnalysisRow; cleanup: () => void } {
  const bizId = `tone-gate-en-${randomUUID()}`;
  const paId = randomUUID();
  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO businesses (id, job_id, name, website, emails_json, loc_country, loc_neighbourhood, category, scraped_at)
    VALUES (?, 'tone-gate-en', ?, ?, '["dryrun@example.test"]', 'United States', 'Brooklyn', 'local business', ?)
  `).run(bizId, `${src.name} (EN demo)`, src.website ?? 'https://example.test', now);
  sqlite.prepare(`
    INSERT INTO premium_analyses (id, business_id, status, signals_json, psi_json, vision_json, detected_sigs_json, created_at, completed_at)
    VALUES (?, ?, 'done', ?, ?, ?, ?, ?, ?)
  `).run(paId, bizId, src.signals_json, src.psi_json, src.vision_json, src.detected_sigs_json, now, now);

  const row: AnalysisRow = {
    business_id: bizId,
    name: `${src.name} (EN demo)`,
    website: src.website,
    loc_country: 'United States',
    signals_json: src.signals_json,
    psi_json: src.psi_json,
    vision_json: src.vision_json,
    detected_sigs_json: src.detected_sigs_json,
  };
  const cleanup = () => {
    sqlite.prepare('DELETE FROM premium_analyses WHERE business_id = ?').run(bizId);
    sqlite.prepare('DELETE FROM businesses WHERE id = ?').run(bizId);
  };
  return { row, cleanup };
}

function chatState(s: SignalMap | undefined): string {
  return s?.hasLiveChatWidget?.state ?? 'missing';
}
function pixelState(s: SignalMap | undefined): string {
  return s?.hasMetaPixel?.state ?? 'missing';
}

async function runOne(label: string, row: AnalysisRow): Promise<boolean> {
  const business = getBusinessForEmail(row.business_id);
  if (!business) {
    console.log(`\n[${label}] business ${row.business_id} not found — skipping`);
    return false;
  }
  const isAR = business.locCountry === 'Argentina';
  const signalMap = parseSignals(row.signals_json);
  const detectedSigs: DetectedSig[] | undefined = row.detected_sigs_json ? JSON.parse(row.detected_sigs_json) : undefined;
  const psiData: PsiData | null = row.psi_json ? JSON.parse(row.psi_json) : null;
  const visionResult: VisionResult | null = row.vision_json ? JSON.parse(row.vision_json) : null;

  const ranked = rankAnchors(business, detectedSigs, psiData, visionResult, signalMap);
  const result = await composeVerifiedEmail(business, undefined, detectedSigs, psiData, visionResult, signalMap, row.business_id);
  const v = result.verdict;
  const sendAllowed = SEND_ALLOWED_STATUSES.includes(v.status);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`[${label}] ${business.name}  (${isAR ? 'ES / Argentina' : 'EN / ' + (business.locCountry ?? '—')})`);
  console.log(`website: ${business.website ?? '—'}`);
  console.log(`signals: pixel=${pixelState(signalMap)}  chat/assistant=${chatState(signalMap)}`);
  console.log(`top-ranked anchor: ${ranked[0]?.id ?? '-'} (${ranked[0]?.kind ?? '-'})`);
  console.log(`anchor used (survived): ${v.anchorId ?? '-'}  fact="${v.anchorFact ?? '-'}"`);
  console.log(`status=${v.status}  disposition=${v.disposition ?? '-'}  sendAllowed=${sendAllowed}`);

  console.log('declared claims + verdict:');
  if (!v.claims.length) {
    console.log('  (none)');
  } else {
    for (const c of v.claims) {
      console.log(`  - [${c.supported ? 'SUPPORTED' : 'UNSUPPORTED'}] "${c.claim}"`);
      console.log(`      evidence: ${c.evidence}`);
    }
  }

  console.log(`\nsubject: ${result.subject || '(held — no body)'}`);
  console.log('body:');
  console.log(result.body ? result.body.split('\n').map(l => '  ' + l).join('\n') : '  (held — no body)');

  const unsupportedSurvived = sendAllowed && v.claims.some(c => !c.supported);
  if (unsupportedSurvived) {
    console.log('\n*** WARNING: an UNSUPPORTED claim survived into a send-allowed draft ***');
  }
  return true;
}

async function main(): Promise<void> {
  const all = stmtLatestDone.all();
  if (!all.length) {
    throw new Error('No completed premium analyses with signals found. Run the analyzer on some leads first.');
  }

  // Auto-classify from stored signals.
  const byId = new Map(all.map(r => [r.business_id, r]));
  const withChat = all.map(r => ({ r, sig: parseSignals(r.signals_json) }));

  const gatedAR = withChat.find(x => x.r.loc_country === 'Argentina' && x.sig?.hasLiveChatWidget?.state === 'ABSENT_VERIFIED');
  const gatedAny = withChat.find(x => x.sig?.hasLiveChatWidget?.state === 'ABSENT_VERIFIED');
  const ungated = withChat.find(x => {
    const st = x.sig?.hasLiveChatWidget?.state;
    return st === 'PRESENT' || st === 'UNKNOWN';
  });
  const enLead = withChat.find(x => x.r.loc_country && x.r.loc_country !== 'Argentina');
  const funda = withChat.find(x => /estudio\s*fun/i.test(x.r.name));

  // Allow explicit overrides.
  const pick = (id: string | undefined): AnalysisRow | undefined => (id ? byId.get(id) : undefined);
  const gatedRow = pick(arg('gated')) ?? pick(arg('es')) ?? (gatedAR ?? gatedAny)?.r;

  // EN demo: prefer a real non-AR analyzed lead; else synthesize from the gated lead.
  const cleanups: Array<() => void> = [];
  let enRow = pick(arg('en')) ?? enLead?.r;
  if (!enRow) {
    const src = gatedRow ?? all[0];
    if (src) {
      const syn = synthesizeEnLead(src);
      enRow = syn.row;
      cleanups.push(syn.cleanup);
      console.log(`(no analyzed non-AR lead — synthesized EN demo from "${src.name}")`);
    }
  }

  const targets: Array<{ label: string; row: AnalysisRow | undefined }> = [
    { label: 'GATED (no-assistant, AR/ES)', row: gatedRow },
    { label: 'UNGATED (chat PRESENT/UNKNOWN)', row: pick(arg('ungated')) ?? ungated?.r },
    { label: 'EN demo', row: enRow },
    { label: 'Estudio FUN (before/after)', row: pick(arg('funda')) ?? funda?.r },
  ];

  console.log('Selected leads:');
  for (const t of targets) {
    console.log(`  ${t.label}: ${t.row ? `${t.row.name} (${t.row.business_id})` : 'NONE FOUND'}`);
  }

  try {
    const seen = new Set<string>();
    for (const t of targets) {
      if (!t.row) {
        console.log(`\n[${t.label}] no matching lead in DB — skipping`);
        continue;
      }
      if (seen.has(t.row.business_id)) {
        console.log(`\n[${t.label}] same lead as a prior target (${t.row.name}) — skipping duplicate`);
        continue;
      }
      seen.add(t.row.business_id);
      await runOne(t.label, t.row);
    }

    // Before/after for Estudio FUN: the stored draft (pre-change) vs the new generation.
    const fundaRow = pick(arg('funda')) ?? funda?.r;
    if (fundaRow) {
      const before = sqlite.prepare<[string], { subject: string; body: string }>(
        'SELECT subject, body FROM outreach_drafts WHERE business_id = ?',
      ).get(fundaRow.business_id);
      console.log(`\n${'#'.repeat(78)}`);
      console.log(`BEFORE / AFTER — ${fundaRow.name}`);
      console.log('#'.repeat(78));
      if (before) {
        console.log('\nBEFORE (stored draft, pre-change — assertive present tense, no assistant offer):');
        console.log(before.body.split('\n').map(l => '  ' + l).join('\n'));
      } else {
        console.log('\nBEFORE: no stored draft found.');
      }
      console.log('\nAFTER: see the GATED run above (hedged consequence + gated no-assistant hook + assistant offer).');
    }
  } finally {
    for (const c of cleanups) c();
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('Dry-run complete. No emails were sent.');
}

main().catch(err => {
  console.error('tone/assistant-offer gate failed:', err);
  process.exit(1);
});
