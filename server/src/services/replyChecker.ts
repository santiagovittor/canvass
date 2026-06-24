import { ImapFlow, FetchMessageObject } from 'imapflow';
import { getSenders } from './senders';
import { getMeta, setMeta, getReplyCheckTargets, markReplied, setReplyType, markEmailSendBounced, upsertEmailValidity, ReplyType } from '../db';
import { broadcast } from '../sse';

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

// ── Bounce (DSN) parsing (slice 0013) ─────────────────────────────────────────
// RFC 3464 delivery-status notifications. We only treat a PERMANENT failure
// (Status 5.x.x, or Action: failed + a 5xx diagnostic) as a bounce — 4.x is a
// transient delay that may still deliver. Returns the failed recipient addresses.
const FINAL_RCPT_RE = /^(?:Final|Original)-Recipient:\s*[A-Za-z0-9-]+\s*;\s*(.+?)\s*$/gim;
const PERM_STATUS_RE = /^Status:\s*5\.\d+\.\d+/im;
const FAILED_ACTION_RE = /^Action:\s*failed/im;
const DIAG_5XX_RE = /Diagnostic-Code:\s*[^;]+;\s*5\d\d\b/i;

export function parseDsnRecipients(source: string): string[] {
  const permanent = PERM_STATUS_RE.test(source) || (FAILED_ACTION_RE.test(source) && DIAG_5XX_RE.test(source));
  if (!permanent) return [];
  const out = new Set<string>();
  FINAL_RCPT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FINAL_RCPT_RE.exec(source))) {
    const raw = m[1].trim().replace(/^<|>$/g, '');
    if (raw.indexOf('@') > 0) out.add(raw.toLowerCase());
  }
  return [...out];
}

// Auto-reply detection by headers + subject only (slice 0014). The earlier
// reply-velocity window (<3 min → auto, 3–8 min → unknown) was dropped: it
// false-positived fast human replies (e.g. Aurora Estudio). Header/subject
// signals are reliable; anything without them is a real reply.
export function classifyReply(msg: FetchMessageObject): ReplyType {
  const headers = parseHeaders(msg.headers);

  const autoSubmitted = headers.get('auto-submitted');
  if (autoSubmitted && !/^no\b/i.test(autoSubmitted)) return 'auto';
  const precedence = headers.get('precedence');
  if (precedence && /bulk|auto_reply|auto-reply|junk/i.test(precedence)) return 'auto';
  if (headers.has('x-auto-response-suppress') || headers.has('x-autoreply') || headers.has('x-autorespond')) return 'auto';

  if (msg.envelope?.subject && AUTO_SUBJECT_RE.test(msg.envelope.subject)) return 'auto';

  return 'real';
}

export async function checkReplies(): Promise<{ checked: number; matched: number; bounced: number }> {
  const senders = getSenders();
  if (senders.length === 0) {
    throw new Error('not_configured');
  }
  if (running) return { checked: 0, matched: 0, bounced: 0 };
  running = true;

  try {
    const targets = getReplyCheckTargets();
    const byEmail = new Map<string, (typeof targets)[number]>();
    // Stable copy for bounce matching — byEmail is mutated (.delete) during reply
    // matching, but a DSN must resolve against the full contacted set.
    const bounceByEmail = new Map<string, (typeof targets)[number]>();
    for (const t of targets) {
      for (const email of t.emails) { byEmail.set(email, t); bounceByEmail.set(email, t); }
    }
    if (byEmail.size === 0) return { checked: 0, matched: 0, bounced: 0 };

    const hasRetro = targets.some(t => t.retro);

    // IMAP SEARCH SINCE is day-granular — overlap 1 day; markReplied is idempotent.
    // Retro targets (replied before reply_type existed) need the full window once.
    const lastCheck = getMeta(LAST_CHECK_KEY);
    const since = hasRetro || !lastCheck
      ? new Date(Date.now() - 30 * 86_400_000)
      : new Date(new Date(lastCheck).getTime() - 86_400_000);

    let checked = 0;
    let matched = 0;
    let bounced = 0;
    // Shared across inboxes: a business bounces once (the DSN lands at the sender that
    // sent it), and byEmail.delete dedups replies — so a hit in either inbox is final.
    // ponytail: shared byEmail means a reply routed into the "wrong" sender's inbox is
    // still matched when THAT inbox is scanned; only a duplicate second reply is deduped.
    // Correct for direct Gmail accounts; revisit if aliases/catch-alls/forwarding appear.
    const bouncedIds = new Set<string>();

    // Scan every sender's inbox (slice 0027). Each sender authenticates with its own
    // App Password; ownAddress is that sender's own address.
    for (const sender of senders) {
      const client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user: sender.from, pass: sender.appPassword },
        logger: false,
      });

      await client.connect();
      try {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const ownAddress = sender.from.toLowerCase();
          for await (const msg of client.fetch({ since }, { envelope: true, headers: AUTO_HEADERS })) {
            checked++;
            for (const from of msg.envelope?.from ?? []) {
              const addr = from.address?.toLowerCase();
              if (!addr || addr === ownAddress) continue;
              const hit = byEmail.get(addr);
              if (!hit) continue;
              const type = classifyReply(msg);
              if (hit.retro) {
                if (setReplyType(hit.id, type)) {
                  console.log(`[replyChecker] retro-classified ${hit.name} as '${type}'`);
                }
              } else if (markReplied(hit.id, type)) {
                matched++;
                console.log(`[replyChecker] reply detected from ${addr} → ${hit.name} (${type}) in ${sender.from}`);
                broadcast('email:replied', { businessId: hit.id, name: hit.name, replyType: type });
              }
              byEmail.delete(addr);
            }
          }

          // ── Bounce (DSN) pass: delivery-status notifications come from
          // mailer-daemon/postmaster. Fetch their full source, parse RFC 3464 for
          // permanently-failed recipients, flag the lead + flip its send to 'bounced'.
          for await (const msg of client.fetch(
            { since, or: [{ from: 'mailer-daemon' }, { from: 'postmaster' }] },
            { source: true },
          )) {
            const src = msg.source?.toString('utf8');
            if (!src) continue;
            for (const rcpt of parseDsnRecipients(src)) {
              const hit = bounceByEmail.get(rcpt);
              if (!hit || bouncedIds.has(hit.id)) continue;
              bouncedIds.add(hit.id);
              // Flag the address dead regardless; bump the count only when a real
              // 'sent' row flips (dry-run/legacy rows have none).
              upsertEmailValidity(rcpt, 'invalid', false, 'bounce');
              if (markEmailSendBounced(hit.id)) {
                bounced++;
                console.log(`[replyChecker] bounce detected for ${rcpt} → ${hit.name} in ${sender.from}`);
                broadcast('email:bounced', { businessId: hit.id, name: hit.name, email: rcpt });
              }
            }
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
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
    return { checked, matched, bounced };
  } finally {
    running = false;
  }
}

export function startReplyChecker(): void {
  if (getSenders().length === 0) {
    console.log('[replyChecker] Gmail credentials not configured — checker disabled');
    return;
  }
  const run = () => {
    checkReplies()
      .then(({ checked, matched, bounced }) => {
        if (matched > 0 || bounced > 0) console.log(`[replyChecker] ${checked} messages checked, ${matched} replies matched, ${bounced} bounced`);
      })
      .catch(err => console.error('[replyChecker]', err instanceof Error ? err.message : err));
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, CHECK_INTERVAL_MS).unref();
}
