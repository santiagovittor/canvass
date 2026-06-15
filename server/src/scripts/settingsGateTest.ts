/**
 * Live verification gate for the Settings tab (live config surface). Exercises the
 * REAL accessor against the REAL DB: precedence (default < env < db) + hard-ceiling
 * clamp, live propagation into capRemaining / withinWindow / rankAnchors with NO
 * restart, validation rejection, secret masking, live signature reload, and reset.
 *
 * Run (in the server container):
 *   npx tsx src/scripts/settingsGateTest.ts
 *
 * Every override written here is reset, and the signature file is restored, on exit.
 */
import { env } from '../env';
import {
  getNumber, getString, setSetting, resetSetting, effectiveSettings,
  SettingsValidationError,
} from '../services/appSettings';
import { getField } from '../services/settingsRegistry';
import { upsertAppSetting, getAllAppSettings } from '../db';
import { capRemaining, withinWindow } from '../services/outreachGovernor';
import { getDailyCapRolling } from '../services/outreachSchedulingConfig';
import { rankAnchors } from '../services/anchorRanker';
import * as emailSender from '../services/emailSender';
import type { PsiData } from '../db/psiCache';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

// Keys this script overrides — reset on exit so the real config is left untouched.
const TOUCHED = ['OUTREACH_DAILY_CAP', 'PACING_MIN_MS', 'GENERIC_WINDOW_START', 'PSI_CRITICAL', 'GEMINI_RPM'];
const sigSnapshot = emailSender.signatureHtml;

function cleanup(): void {
  for (const k of TOUCHED) { try { resetSetting(k); } catch { /* not set */ } }
  // Restore the signature file to whatever it was before the run.
  if (sigSnapshot !== null) { try { emailSender.reloadSignature(sigSnapshot); } catch { /* ignore */ } }
}

async function main(): Promise<void> {
  // ── 1. Precedence: default → env → db ───────────────────────────────────────
  console.log('\n1 — precedence (default < env < db)');
  const capField = getField('OUTREACH_DAILY_CAP')!;
  const codeDefault = capField.default as number;
  const envVal = env.OUTREACH_DAILY_CAP;
  console.log(`    code default = ${codeDefault}`);
  console.log(`    env override = ${envVal}  (OUTREACH_DAILY_CAP)`);
  assert('with no db override, getNumber === env value', getNumber('OUTREACH_DAILY_CAP') === envVal, `got ${getNumber('OUTREACH_DAILY_CAP')}`);
  setSetting('OUTREACH_DAILY_CAP', 22);
  console.log(`    db override  = 22`);
  assert('db override wins', getNumber('OUTREACH_DAILY_CAP') === 22, `got ${getNumber('OUTREACH_DAILY_CAP')}`);

  // ── 2. Hard-ceiling clamp (after merge), even for a persisted over-ceiling value ──
  console.log('\n2 — GMAIL_HARD_CEILING clamp');
  let rejected = false;
  try { setSetting('OUTREACH_DAILY_CAP', 9999); } catch (e) { rejected = e instanceof SettingsValidationError; }
  assert('write above ceiling rejected by validation (max=400)', rejected);
  // Persist an over-ceiling value directly (bypassing validation), then force the
  // accessor cache to refresh via a sibling write, and prove getNumber clamps it.
  upsertAppSetting('OUTREACH_DAILY_CAP', JSON.stringify(9999));
  setSetting('PACING_MIN_MS', getNumber('PACING_MIN_MS')); // no-op value, invalidates cache
  assert('persisted 9999 is clamped to 400 on read', getNumber('OUTREACH_DAILY_CAP') === 400, `got ${getNumber('OUTREACH_DAILY_CAP')}`);

  // ── 3. Live propagation — no restart ────────────────────────────────────────
  console.log('\n3 — live propagation (no restart)');
  // 3a. 24h cap → capRemaining
  resetSetting('OUTREACH_DAILY_CAP');
  setSetting('OUTREACH_DAILY_CAP', 7);
  const capBefore = capRemaining();
  setSetting('OUTREACH_DAILY_CAP', 12);
  const capAfter = capRemaining();
  assert('getDailyCapRolling reflects live edit', getDailyCapRolling() === 12, `got ${getDailyCapRolling()}`);
  assert('capRemaining moved by +5 with the cap', capAfter - capBefore === 5, `before=${capBefore} after=${capAfter}`);

  // 3b. send window → withinWindow
  const WED_11_BA = Date.UTC(2026, 5, 17, 14, 0, 0); // Wed 17 Jun 11:00 BA (UTC-3)
  resetSetting('GENERIC_WINDOW_START');
  const inWinDefault = withinWindow(WED_11_BA, 'generic'); // 09:00–18:00 → true
  setSetting('GENERIC_WINDOW_START', '12:00');
  const inWinAfter = withinWindow(WED_11_BA, 'generic');  // 12:00–18:00 → 11:00 excluded
  assert('window default includes Wed 11:00', inWinDefault === true);
  assert('live window start=12:00 excludes Wed 11:00', inWinAfter === false);

  // 3c. anchor threshold → rankAnchors
  const psi: PsiData = { mobileScore: 60, lcp: null } as PsiData;
  const biz = { category: 'Cafetería', locCountry: 'Argentina' };
  resetSetting('PSI_CRITICAL');
  const beforePsiAnchor = rankAnchors(biz, undefined, psi).some(c => c.kind === 'psi'); // 60 < 50? no
  setSetting('PSI_CRITICAL', 70);
  const afterPsiAnchor = rankAnchors(biz, undefined, psi).some(c => c.kind === 'psi');  // 60 < 70? yes
  assert('PSI 60 is not an anchor at threshold 50', beforePsiAnchor === false);
  assert('PSI 60 becomes an anchor at live threshold 70', afterPsiAnchor === true);

  // ── 4. Validation — out-of-range rejected, stored value unchanged ────────────
  console.log('\n4 — validation');
  setSetting('PSI_CRITICAL', 55);
  let psiRejected = false;
  try { setSetting('PSI_CRITICAL', 999); } catch (e) { psiRejected = e instanceof SettingsValidationError; }
  assert('out-of-range PSI write rejected', psiRejected);
  assert('stored PSI unchanged after rejected write', getNumber('PSI_CRITICAL') === 55, `got ${getNumber('PSI_CRITICAL')}`);

  // ── 5. Secret safety — masked only, never in app_settings, never plaintext ───
  console.log('\n5 — secret safety');
  const eff = effectiveSettings();
  const secretFields = eff.groups.flatMap(g => g.fields).filter(f => f.isSecret);
  assert('secret fields expose no plaintext value', secretFields.every(f => f.value === undefined));
  assert('secret fields expose only masked status', secretFields.every(f => f.secret !== undefined && !('value' in f && f.value !== undefined)));
  let secretWriteRejected = false;
  try { setSetting('GEMINI_API_KEY', 'pwn'); } catch (e) { secretWriteRejected = e instanceof SettingsValidationError; }
  assert('secret write rejected', secretWriteRejected);
  const rows = getAllAppSettings().map(r => r.key);
  assert('no secret key persisted in app_settings', !rows.some(k => getField(k)?.isSecret));

  // ── 6. Signature live reload — no restart ───────────────────────────────────
  console.log('\n6 — signature live reload');
  const base = emailSender.signatureHtml ?? '';
  const marker = `<!--gate-${Date.now()}-->`;
  setSetting('EMAIL_SIGNATURE_HTML', base + marker);
  assert('emailSender.signatureHtml updated in place', (emailSender.signatureHtml ?? '').endsWith(marker), 'handle not reassigned');
  assert('signature not persisted to app_settings (file-backed)', !getAllAppSettings().some(r => r.key === 'EMAIL_SIGNATURE_HTML'));

  // ── 8. Reset reverts to env/default ─────────────────────────────────────────
  console.log('\n8 — reset');
  setSetting('GEMINI_RPM', 25);
  assert('override applied', getNumber('GEMINI_RPM') === 25);
  resetSetting('GEMINI_RPM');
  assert('reset reverts to env/default', getNumber('GEMINI_RPM') === env.GEMINI_RPM, `got ${getNumber('GEMINI_RPM')}`);

  // model getter sanity
  assert('GEMINI_MODEL default resolves', getString('GEMINI_MODEL') === 'gemini-3.5-flash', `got ${getString('GEMINI_MODEL')}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed.`);
}

main()
  .then(cleanup)
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch(err => { console.error('gate crashed:', err); cleanup(); process.exit(1); });
