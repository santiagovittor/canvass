import { env } from '../env';

// Sending identities (slice 0027). The app rotates across this list; only two are
// configured (out of scope: more), but everything downstream iterates the array so
// adding a third later is config-only. Each sender has its own rolling-24h cap
// setting (capKey) so a warmed account and a fresh one ramp independently.
//
// Back-compat: GMAIL_FROM/GMAIL_APP_PASSWORD remain sender #1 (capKey
// OUTREACH_DAILY_CAP). A second GMAIL_FROM_2/GMAIL_APP_PASSWORD_2 pair adds sender #2
// (capKey OUTREACH_DAILY_CAP_2). env.ts validates each pair is set together.

export interface Sender {
  index: number;       // 0-based; tie-break order for least-loaded rotation
  from: string;        // the Gmail address — also the email_sends.sender value
  appPassword: string; // App Password for SMTP + IMAP auth
  capKey: string;      // settings key for this sender's rolling-24h cap
}

export function getSenders(): Sender[] {
  const list: Sender[] = [];
  if (env.GMAIL_FROM && env.GMAIL_APP_PASSWORD) {
    list.push({ index: 0, from: env.GMAIL_FROM, appPassword: env.GMAIL_APP_PASSWORD, capKey: 'OUTREACH_DAILY_CAP' });
  }
  if (env.GMAIL_FROM_2 && env.GMAIL_APP_PASSWORD_2) {
    list.push({ index: list.length, from: env.GMAIL_FROM_2, appPassword: env.GMAIL_APP_PASSWORD_2, capKey: 'OUTREACH_DAILY_CAP_2' });
  }
  return list;
}

// First configured sender — the back-compat default when no rotation is in play.
export function defaultSender(): Sender | undefined {
  return getSenders()[0];
}

export function getSenderByFrom(from: string): Sender | undefined {
  const f = from.toLowerCase();
  return getSenders().find(s => s.from.toLowerCase() === f);
}
