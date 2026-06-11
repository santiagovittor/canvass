import { ImapFlow, FetchMessageObject } from 'imapflow';
import { env } from '../env';
import { getMeta, setMeta, getReplyCheckTargets, markReplied, setReplyType, ReplyType } from '../db';
import { broadcast } from '../sse';
import { UTC_MINUS_3_OFFSET_MS } from '../util/time';

const LAST_CHECK_KEY = 'replyChecker.lastCheck';
const CHECK_INTERVAL_MS = 10 * 60_000;

const AUTO_HEADERS = ['auto-submitted', 'precedence', 'x-auto-response-suppress', 'x-autoreply', 'x-autorespond'];

const AUTO_SUBJECT_RE = /out of office|automatic reply|auto[- ]?reply|autoreply|fuera de (la )?oficina|ausencia|respuesta autom[aá]tica/i;

let running = false;

function parseHeaders(buf?: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  if (!buf) return map;
  const text = buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' '); // unfold continuations
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return map;
}

export function classifyReply(msg: FetchMessageObject, lastSentAt: string | null): ReplyType {
  const headers = parseHeaders(msg.headers);

  const autoSubmitted = headers.get('auto-submitted');
  if (autoSubmitted && !/^no\b/i.test(autoSubmitted)) return 'auto';
  const precedence = headers.get('precedence');
  if (precedence && /bulk|auto_reply|auto-reply|junk/i.test(precedence)) return 'auto';
  if (headers.has('x-auto-response-suppress') || headers.has('x-autoreply') || headers.has('x-autorespond')) return 'auto';

  if (msg.envelope?.subject && AUTO_SUBJECT_RE.test(msg.envelope.subject)) return 'auto';

  if (lastSentAt && msg.envelope?.date) {
    const sentMs = Date.parse(lastSentAt) + UTC_MINUS_3_OFFSET_MS;
    const deltaMin = (msg.envelope.date.getTime() - sentMs) / 60_000;
    if (deltaMin >= 0 && deltaMin < 3) return 'auto';      // machine speed
    if (deltaMin >= 3 && deltaMin < 8) return 'unknown';   // suspicious, fast human possible
    // negative delta = inbox mail predating our send — not a usable velocity signal
  }

  return 'real';
}

export async function checkReplies(): Promise<{ checked: number; matched: number }> {
  if (!env.GMAIL_FROM || !env.GMAIL_APP_PASSWORD) {
    throw new Error('not_configured');
  }
  if (running) return { checked: 0, matched: 0 };
  running = true;

  try {
    const targets = getReplyCheckTargets();
    const byEmail = new Map<string, (typeof targets)[number]>();
    for (const t of targets) {
      for (const email of t.emails) byEmail.set(email, t);
    }
    if (byEmail.size === 0) return { checked: 0, matched: 0 };

    const hasRetro = targets.some(t => t.retro);

    // IMAP SEARCH SINCE is day-granular — overlap 1 day; markReplied is idempotent.
    // Retro targets (replied before reply_type existed) need the full window once.
    const lastCheck = getMeta(LAST_CHECK_KEY);
    const since = hasRetro || !lastCheck
      ? new Date(Date.now() - 30 * 86_400_000)
      : new Date(new Date(lastCheck).getTime() - 86_400_000);

    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: env.GMAIL_FROM, pass: env.GMAIL_APP_PASSWORD },
      logger: false,
    });

    let checked = 0;
    let matched = 0;

    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const ownAddress = env.GMAIL_FROM.toLowerCase();
        for await (const msg of client.fetch({ since }, { envelope: true, headers: AUTO_HEADERS })) {
          checked++;
          for (const from of msg.envelope?.from ?? []) {
            const addr = from.address?.toLowerCase();
            if (!addr || addr === ownAddress) continue;
            const hit = byEmail.get(addr);
            if (!hit) continue;
            const type = classifyReply(msg, hit.lastSentAt);
            if (hit.retro) {
              if (setReplyType(hit.id, type)) {
                console.log(`[replyChecker] retro-classified ${hit.name} as '${type}'`);
              }
            } else if (markReplied(hit.id, type)) {
              matched++;
              console.log(`[replyChecker] reply detected from ${addr} → ${hit.name} (${type})`);
              broadcast('email:replied', { businessId: hit.id, name: hit.name, replyType: type });
            }
            byEmail.delete(addr);
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }

    // Unmatched retro targets finalize as 'unknown' (message archived/deleted or
    // older than the window) so the widened 30-day fetch never recurs.
    if (hasRetro) {
      const finalized = new Set<string>();
      for (const t of byEmail.values()) {
        if (!t.retro || finalized.has(t.id)) continue;
        setReplyType(t.id, 'unknown');
        finalized.add(t.id);
        console.log(`[replyChecker] retro target ${t.name} not found in INBOX — marked 'unknown'`);
      }
    }

    setMeta(LAST_CHECK_KEY, new Date().toISOString());
    return { checked, matched };
  } finally {
    running = false;
  }
}

export function startReplyChecker(): void {
  if (!env.GMAIL_FROM || !env.GMAIL_APP_PASSWORD) {
    console.log('[replyChecker] Gmail credentials not configured — checker disabled');
    return;
  }
  const run = () => {
    checkReplies()
      .then(({ checked, matched }) => {
        if (matched > 0) console.log(`[replyChecker] ${checked} messages checked, ${matched} replies matched`);
      })
      .catch(err => console.error('[replyChecker]', err instanceof Error ? err.message : err));
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, CHECK_INTERVAL_MS).unref();
}
