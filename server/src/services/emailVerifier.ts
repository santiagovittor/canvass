import { resolveMx } from 'dns/promises';
import net from 'net';
import { env } from '../env';
import {
  validateEmail, isPlaceholderEmail, getEmailValidity, upsertEmailValidity,
  type EmailValidity,
} from '../db';

// Pre-compose deliverability gate (slice 0013). Establishes, without a paid API,
// whether an address can plausibly receive mail:
//   placeholder/malformed → invalid (no network)
//   no MX / dead domain    → invalid
//   MX ok, probe off       → unknown
//   SMTP discriminates: real 2xx + random 5xx → valid; real 5xx + random 2xx → invalid
//   reject-all (both 5xx, e.g. M365) / catch-all (both 2xx) → unknown (can't confirm)
//   greylist / timeout / refused → unknown
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
  const real5xx = verdict.code >= 500 && verdict.code < 600;
  const randOk = verdict.randomCode >= 200 && verdict.randomCode < 300;
  const rand5xx = verdict.randomCode >= 500 && verdict.randomCode < 600;

  if (realOk && rand5xx) return { result: 'valid', mxOk: true };   // discriminates, accepted real
  if (real5xx && randOk) return { result: 'invalid', mxOk: true }; // discriminates, rejected real
  return { result: 'unknown', mxOk: true };                        // both same (reject-all/catch-all), 4xx greylist, etc.
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
