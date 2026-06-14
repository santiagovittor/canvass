/**
 * Live verification gate + replay harness for the anchor-by-construction +
 * specificity-guard slice.
 *
 * Runs the REAL pipeline (composeVerifiedEmail → the shipped compose/verify/
 * repair/guard loop) against real leads in the dev DB, then exercises the REAL
 * send gate (SEND_ALLOWED_STATUSES) with a sendEmail spy — to the send boundary,
 * zero addresses burned. Asserts no known-husk lead produces a sent generic email.
 *
 * Run inside the node:20 server container:
 *   docker compose -f docker-compose.dev.yml exec -T server \
 *     npx tsx server/scripts/anchorGateReplay.ts
 */
import Database from 'better-sqlite3';
import { rankAnchors } from '../src/services/anchorRanker';
import { composeVerifiedEmail } from '../src/services/outreachComposePipeline';
import { SEND_ALLOWED_STATUSES, type VerificationResult } from '../src/services/geminiVerifier';
import type { BusinessForEmail } from '../src/services/geminiComposer';

const DB_PATH = process.env.DATABASE_URL || '/app/data/scraper.db';
const db = new Database(DB_PATH, { readonly: true });

interface LeadRow {
  id: string; name: string; category: string | null; lc: string | null; ln: string | null;
  website: string | null; rating: number | null; rc: number | null;
  psi_json: string | null; vision_json: string | null; signals_json: string | null; detected_sigs_json: string | null;
  vj: string | null; obody: string | null;
}

// Latest done premium analysis per business, joined to any stored (OLD) draft.
const rows = db.prepare(`
  SELECT b.id, b.name, b.category, b.loc_country lc, b.loc_neighbourhood ln, b.website,
         b.rating, b.review_count rc,
         pa.psi_json, pa.vision_json, pa.signals_json, pa.detected_sigs_json,
         od.verification_json vj, od.body obody
  FROM premium_analyses pa
  JOIN businesses b ON b.id = pa.business_id
  LEFT JOIN outreach_drafts od ON od.business_id = b.id
  WHERE pa.status = 'done'
  ORDER BY pa.completed_at DESC
`).all() as LeadRow[];

// Dedup to latest row per business.
const byId = new Map<string, LeadRow>();
for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
const leads = [...byId.values()];

function parse<T>(s: string | null): T | undefined { try { return s ? JSON.parse(s) as T : undefined; } catch { return undefined; } }
function biz(r: LeadRow): BusinessForEmail {
  return { name: r.name, category: r.category, website: r.website, locCountry: r.lc, locNeighbourhood: r.ln, rating: r.rating, reviewCount: r.rc };
}
function firstSentence(s: string | null): string {
  if (!s) return '(empty)';
  const t = s.replace(/\n+/g, ' ').trim();
  const m = t.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : t).slice(0, 150).trim();
}
function oldStatus(r: LeadRow): string {
  const v = parse<VerificationResult>(r.vj);
  return v?.status ?? '(none)';
}

async function runNew(r: LeadRow): Promise<VerificationResult & { _subject: string; _body: string }> {
  const res = await composeVerifiedEmail(
    biz(r), undefined,
    parse(r.detected_sigs_json), parse(r.psi_json) ?? null, parse(r.vision_json) ?? null, parse(r.signals_json),
  );
  return { ...res.verdict, _subject: res.subject, _body: res.body };
}

// ---- Send gate (the real predicate) + sendEmail spy ----
let sendSpyCalls = 0;
const sentTo: string[] = [];
function gate(name: string, verdict: VerificationResult): 'SENT' | 'BLOCKED' {
  // Mirrors outreachQueue.ts /send: only allowlisted statuses pass without override.
  if (SEND_ALLOWED_STATUSES.includes(verdict.status)) {
    sendSpyCalls++; sentTo.push(name);   // dry-run "send" — no SMTP
    return 'SENT';
  }
  return 'BLOCKED';
}
function bodyHasSurvivingClaim(verdict: VerificationResult & { _body: string }): boolean {
  return verdict.claims.some(c => c.supported) && verdict._body.trim().length > 0;
}

async function main() {
  console.log(`Leads with done premium analysis: ${leads.length}`);
  const zeroCand = leads.filter(r => rankAnchors(biz(r), parse(r.detected_sigs_json), parse(r.psi_json) ?? null, parse(r.vision_json) ?? null, parse(r.signals_json)).length === 0);
  console.log(`Zero-assertable-evidence leads (NEW must hold): ${zeroCand.length}\n`);

  // Leads for the before/after table: the real OLD husks + a few strong-anchor leads.
  const TABLE_IDS = [
    'ChIJ83BivCi2vJURmaN1uYxd2Cw', // Estudio Paraiso — OLD violations_stripped (husk)
    'ChIJ4ZKPBcjKvJURsRcbujW0Mb4', // Estudio Ferro Abogados — OLD ok (generic)
    'ChIJP1QH7ksLu5URkNl3AgkkXoo', // ROCCHI estudio — psi 37/100
    'ChIJA8cDOYWkvJURzp8mOoxPhUw', // Atila Gym — psi 40/100
    'ChIJT1pxaTq2vJURsKsfFKU4LRc', // Estudio LeMonde — vision opportunity
    'ChIJG4rxvI-kvJURGbwZA_r3KWY', // Farmacia Pacheco — psi 47/100
  ];

  // Known husk set the replay must protect: every lead whose OLD pipeline produced
  // a sendable status (ok / violations_stripped), plus all zero-evidence leads.
  const sendableOld = new Set(['ok', 'violations_stripped']);
  const huskLeads = leads.filter(r => sendableOld.has(oldStatus(r)));
  const replaySet = [...new Map([...huskLeads, ...zeroCand, ...TABLE_IDS.map(id => byId.get(id)).filter(Boolean) as LeadRow[]].map(r => [r.id, r])).values()];

  const results = new Map<string, VerificationResult & { _subject: string; _body: string }>();
  console.log(`Running NEW pipeline live over ${replaySet.length} leads (Gemini for anchored leads)...\n`);
  for (const r of replaySet) {
    try { results.set(r.id, await runNew(r)); }
    catch (e) { console.error(`  ! ${r.name}: ${(e as Error).message}`); }
  }

  // ---- Before/after table ----
  console.log('================ BEFORE / AFTER ================');
  const hdr = ['lead', 'chosen anchor', 'verifier verdict', 'OLD output', 'NEW disposition'];
  console.log(hdr.join(' | '));
  for (const id of TABLE_IDS) {
    const r = byId.get(id); if (!r) { console.log(`${id} (not found)`); continue; }
    const nv = results.get(id);
    const os = oldStatus(r);
    const oldKind = os === 'ok' || os === 'violations_stripped' ? 'GENERIC/sent-eligible' : os;
    const anchor = nv?.anchorId ?? '(none)';
    const verdict = nv ? `${nv.claims.filter(c => c.supported).length}/${nv.claims.length} claims supported` : '(error)';
    const disp = nv?.disposition ?? nv?.status ?? '(error)';
    console.log(`${r.name} | ${anchor} | ${verdict} | ${os} (${oldKind}) | ${disp}`);
  }

  // ---- Sample openings (before vs after) ----
  console.log('\n================ OPENINGS (before vs after) ================');
  for (const id of ['ChIJ83BivCi2vJURmaN1uYxd2Cw', 'ChIJ4ZKPBcjKvJURsRcbujW0Mb4', 'ChIJP1QH7ksLu5URkNl3AgkkXoo']) {
    const r = byId.get(id); if (!r) continue;
    const nv = results.get(id);
    console.log(`\n--- ${r.name} ---`);
    console.log(`OLD: ${firstSentence(r.obody)}`);
    console.log(`NEW: ${nv && nv._body ? firstSentence(nv._body) : `[HELD: ${nv?.status} — ${nv?.error ?? ''}]`}`);
  }

  // ---- Replay assertion: no husk lead produces a SENT generic ----
  console.log('\n================ REPLAY ASSERTIONS ================');
  let failures = 0;
  let sentSpecific = 0, heldGeneric = 0;
  for (const r of replaySet) {
    const nv = results.get(r.id);
    if (!nv) { console.error(`FAIL ${r.name}: pipeline error`); failures++; continue; }
    const decision = gate(r.name, nv);
    if (decision === 'SENT') {
      // A sent email MUST be specific: disposition sent_specific + a surviving supported claim.
      if (nv.disposition !== 'sent_specific' || !bodyHasSurvivingClaim(nv)) {
        console.error(`FAIL ${r.name}: SENT but generic husk (status=${nv.status}, disp=${nv.disposition})`);
        failures++;
      } else { sentSpecific++; }
    } else {
      if (nv.status !== 'held_generic' && nv.status !== 'held' && nv.status !== 'verifier_failed') {
        console.error(`FAIL ${r.name}: BLOCKED with unexpected status ${nv.status}`);
        failures++;
      } else { heldGeneric++; }
    }
  }

  console.log(`\nReplay set: ${replaySet.length} | sent-specific: ${sentSpecific} | held: ${heldGeneric} | sendEmail spy calls: ${sendSpyCalls}`);
  console.log(`Emails the spy "sent": ${sentTo.length ? sentTo.join(', ') : '(none)'}`);
  if (failures === 0) {
    console.log('\n✅ PASS — no known-husk lead produced a sent generic email. Every send carried a surviving prospect-specific anchor.');
    process.exit(0);
  } else {
    console.error(`\n❌ FAIL — ${failures} husk lead(s) would send generic.`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
