import { resolveMx } from 'dns/promises';
import net from 'net';
import { env } from '../env';
import {
  validateEmail, isPlaceholderEmail, getEmailValidity, upsertEmailValidity,
  getBusinessEmails, getLeadsNeedingValidityProbe, type EmailValidity,
} from '../db';

// Pre-compose deliverability gate (slice 0013). Establishes, without a paid API,
// whether an address can plausibly receive mail:
//   placeholder/malformed → invalid (no network)
//   no MX / dead domain    → invalid
//   MX ok, probe off       → unknown
//   SMTP probe is a VALID-only confirmer (slice 0030): real 2xx + random 5xx → valid
//   everything else (probe-reject, reject-all M365, catch-all, greylist, timeout,
//   refused) → unknown. Probe rejection alone can no longer condemn an address;
//   the dead verdicts come from MX non-existence + bounce DSN only.
// Fail-open: any unexpected error degrades to 'unknown', never throws, never blocks
// the pipeline. Results are cached (email_validity) keyed to the address.

const TTL_MS = env.EMAIL_VERIFY_CACHE_TTL_DAYS * 86_400_000;

function heloName(): string {
  const from = env.GMAIL_FROM;
  const dom = from && from.includes('@') ? from.split('@')[1] : null;
  return dom ?? 'localhost';
}

// Minimal SMTP RCPT probe over one socket, bounded by a single budget. Returns the
// numeric reply code for RCPT TO:<addr> (real) plus the code for RCPT to a random
// local-part on the same domain. Comparing the two tells us whether the server
// actually discriminates (slice 0024 symmetry test).
async function smtpProbe(
  mxHost: string, addr: string, domain: string, budgetMs: number,
): Promise<{ code: number; randomCode: number } | null> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: mxHost, port: 25 });
    let stage = 0;
    let buf = '';
    let rcptCode = 0;
    let catchAllCode = 0;
    const randomLocal = `probe-${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
    let settled = false;

    const done = (val: { code: number; randomCode: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);                                    // cancel on every exit path
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(val);
    };

    const timer = setTimeout(() => done(null), budgetMs);
    timer.unref?.();

    const send = (line: string) => socket.write(line + '\r\n');

    socket.setEncoding('ascii');
    socket.on('error', () => done(null));
    socket.on('close', () => {
      // If we got a RCPT verdict before close, report it (guarded; no-op if settled).
      if (rcptCode > 0) done({ code: rcptCode, randomCode: catchAllCode });
      else done(null);
    });

    socket.on('data', chunk => {
      buf += chunk;
      // Process complete reply lines; SMTP final line is "NNN " (space), "NNN-" continues.
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (line.length < 4 || line[3] === '-') continue; // continuation — wait for final
        const code = parseInt(line.slice(0, 3), 10);
        switch (stage) {
          case 0: // greeting
            if (code !== 220) return done(null);
            send(`EHLO ${heloName()}`); stage = 1; break;
          case 1: // EHLO response (may be multiline; handled above)
            if (code !== 250) { send(`HELO ${heloName()}`); stage = 2; break; }
            send(`MAIL FROM:<${env.GMAIL_FROM ?? 'probe@' + heloName()}>`); stage = 3; break;
          case 2: // HELO fallback response
            if (code !== 250) return done(null);
            send(`MAIL FROM:<${env.GMAIL_FROM ?? 'probe@' + heloName()}>`); stage = 3; break;
          case 3: // MAIL FROM response
            if (code !== 250) return done(null);
            send(`RCPT TO:<${addr}>`); stage = 4; break;
          case 4: // RCPT (real address) response
            rcptCode = code;
            send(`RCPT TO:<${randomLocal}@${domain}>`); stage = 5; break;
          case 5: // RCPT (random address) response — catch-all check
            catchAllCode = code;
            send('QUIT'); stage = 6; break;
          default:
            break;
        }
      }
    });
  });
}

async function probe(addr: string): Promise<{ result: EmailValidity; mxOk: boolean }> {
  const domain = addr.slice(addr.indexOf('@') + 1).toLowerCase();
  const budget = env.EMAIL_VERIFY_TIMEOUT_MS;

  // ── DNS MX ──
  let mx: { exchange: string; priority: number }[];
  try {
    const mxTimeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('mx_timeout')), budget).unref?.());
    mx = await Promise.race([resolveMx(domain), mxTimeout]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // Definitive "domain can't receive mail" signals → invalid. Transient → unknown.
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
      return { result: 'invalid', mxOk: false };
    }
    return { result: 'unknown', mxOk: false };
  }
  if (!mx || mx.length === 0) return { result: 'invalid', mxOk: false };

  if (!env.EMAIL_VERIFY_SMTP_PROBE) return { result: 'unknown', mxOk: true };

  // ── SMTP RCPT probe against the most-preferred MX (lowest priority number) ──
  const top = mx.slice().sort((a, b) => a.priority - b.priority)[0].exchange;
  const verdict = await smtpProbe(top, addr, domain, budget);
  if (!verdict) return { result: 'unknown', mxOk: true };          // blocked/timeout/refused

  // Symmetry test (slice 0024): trust a verdict only when the server discriminates
  // between the real address and a random local part. A server that answers both
  // the same way (reject-all M365, or accept-all catch-all) can't confirm anything.
  const realOk = verdict.code >= 200 && verdict.code < 300;
  const rand5xx = verdict.randomCode >= 500 && verdict.randomCode < 600;

  // Slice 0030: the SMTP probe is a valid-ONLY confirmer. The former
  // `real5xx && randOk → invalid` quadrant is removed: M365 mail edges
  // (*.mail.protection.outlook.com) return inconsistent RCPT codes within one
  // session under rate/reputation throttling, manufacturing that exact quadrant
  // and condemning real leads. Probe rejection alone can no longer condemn an
  // address — only a clean accept-real / reject-random discrimination confirms
  // `valid`; everything else falls through to unknown and proceeds.
  // Authoritative dead signals stay elsewhere: MX non-existence (above) and
  // bounce DSN ingestion (slice 0013).
  if (realOk && rand5xx) return { result: 'valid', mxOk: true };   // discriminates, accepted real
  return { result: 'unknown', mxOk: true };                        // probe-reject, both-same, 4xx greylist, etc. → proceed
}

export async function verifyEmailDeliverable(addr: string): Promise<EmailValidity> {
  // Fast deterministic rejects — no network, no cache needed.
  if (!validateEmail(addr)) {
    upsertEmailValidity(addr, 'invalid', false, isPlaceholderEmail(addr) ? 'placeholder' : 'malformed');
    return 'invalid';
  }

  const cached = getEmailValidity(addr);
  if (cached && Date.now() - new Date(cached.checkedAt).getTime() < TTL_MS) {
    return cached.result;
  }

  try {
    const { result, mxOk } = await probe(addr);
    upsertEmailValidity(addr, result, mxOk, 'probe');
    return result;
  } catch {
    // Belt-and-suspenders: never let the gate throw into the batch loop.
    return 'unknown';
  }
}

// Slice 0025: choose the single best-reachable address for a lead. Ranks
// valid > unknown > invalid; ties keep original order. Reuses cached validity and
// PROBES uncached candidates via verifyEmailDeliverable (which caches + bounds each
// probe by EMAIL_VERIFY_TIMEOUT_MS). Short-circuits on the first 'valid' — the top
// rank can't be beaten — so a multi-email lead can't stall a batch probing the rest.
// All-invalid (or none) → the original first, so the lead keeps a target and the
// caller's own 'invalid' skip decides. One address per lead — never multi-send
// (domain-block risk, slice 0022 F3).
const SELECT_RANK: Record<EmailValidity, number> = { valid: 0, unknown: 1, invalid: 2 };
export async function selectBestEmail(businessId: string): Promise<string | null> {
  const emails = getBusinessEmails(businessId);
  if (emails.length <= 1) return emails[0] ?? null;

  let best = emails[0];
  let bestRank = 3;
  for (const addr of emails) {
    const v = await verifyEmailDeliverable(addr);
    if (v === 'valid') return addr;                 // top rank — stop probing
    const rank = SELECT_RANK[v];
    if (rank < bestRank) { best = addr; bestRank = rank; }
  }
  return best;
}

// Slice 0046: paced probe-before-rank backfill. Probes the untouched email pool so
// getOutreachLeads' cache-only validity read (slice 0045) sorts on real verdicts
// (verified replies ~2× unverified — 0043 F4). Reuses selectBestEmail, which probes +
// caches each candidate via verifyEmailDeliverable (TTL-skip → re-runs near-instant).
// Sequential + paced (SOCIAL_ENRICHMENT_DELAY_MS between leads): opens raw port-25
// sockets, must not hammer. Fail-open is selectBestEmail's contract — a probe degrades
// to 'unknown', never throws into the loop. When port 25 is blocked, MX-only verdicts
// (invalid on dead domain, else unknown) still sink dead domains in the ranking.
export async function backfillEmailValidity(
  limit = 50,
): Promise<{ probed: number; valid: number; unknown: number; invalid: number }> {
  const ids = getLeadsNeedingValidityProbe(limit);
  const counts = { probed: 0, valid: 0, unknown: 0, invalid: 0 };
  for (const id of ids) {
    const emails = getBusinessEmails(id);
    if (emails.length === 0) continue;
    // NOT selectBestEmail: it short-circuits single-email leads (the majority) WITHOUT
    // probing them. Probe each candidate directly so every lead gains a cached verdict;
    // mirror selectBestEmail's rank + valid short-circuit to pick the lead's best.
    let best: EmailValidity = 'invalid';
    for (const addr of emails) {
      const v = await verifyEmailDeliverable(addr);  // probes uncached + caches (TTL-skip)
      if (SELECT_RANK[v] < SELECT_RANK[best]) best = v;
      if (v === 'valid') break;                       // top rank — stop probing the rest
    }
    counts.probed++;
    counts[best]++;
    await new Promise(r => setTimeout(r, env.SOCIAL_ENRICHMENT_DELAY_MS));
  }
  console.log(
    `[validity-backfill] probed ${counts.probed}, valid/unknown/invalid = ` +
    `${counts.valid}/${counts.unknown}/${counts.invalid}`,
  );
  return counts;
}
