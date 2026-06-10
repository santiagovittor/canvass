import { ImapFlow } from 'imapflow';
import { env } from '../env';
import { getMeta, setMeta, getContactedBusinessEmails, markReplied } from '../db';
import { broadcast } from '../sse';

const LAST_CHECK_KEY = 'replyChecker.lastCheck';
const CHECK_INTERVAL_MS = 10 * 60_000;

let running = false;

export async function checkReplies(): Promise<{ checked: number; matched: number }> {
  if (!env.GMAIL_FROM || !env.GMAIL_APP_PASSWORD) {
    throw new Error('not_configured');
  }
  if (running) return { checked: 0, matched: 0 };
  running = true;

  try {
    const contacted = getContactedBusinessEmails();
    const byEmail = new Map<string, { id: string; name: string }>();
    for (const c of contacted) {
      for (const email of c.emails) byEmail.set(email, { id: c.id, name: c.name });
    }
    if (byEmail.size === 0) return { checked: 0, matched: 0 };

    // IMAP SEARCH SINCE is day-granular — overlap 1 day; markReplied is idempotent
    const lastCheck = getMeta(LAST_CHECK_KEY);
    const since = lastCheck
      ? new Date(new Date(lastCheck).getTime() - 86_400_000)
      : new Date(Date.now() - 30 * 86_400_000);

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
        for await (const msg of client.fetch({ since }, { envelope: true })) {
          checked++;
          for (const from of msg.envelope?.from ?? []) {
            const addr = from.address?.toLowerCase();
            if (!addr || addr === ownAddress) continue;
            const hit = byEmail.get(addr);
            if (!hit) continue;
            if (markReplied(hit.id)) {
              matched++;
              console.log(`[replyChecker] reply detected from ${addr} → ${hit.name}`);
              broadcast('email:replied', { businessId: hit.id, name: hit.name });
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
