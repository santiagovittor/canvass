import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { env } from '../env';
import { getDailySendCount, recordEmailSend, markContacted, validateEmail } from '../db';

const candidates = [
  env.EMAIL_SIGNATURE_PATH,
  path.resolve(process.cwd(), 'credentials/email-signature.html'),
  path.resolve(process.cwd(), '../credentials/email-signature.html'),
  path.resolve(__dirname, '../../../credentials/email-signature.html'),
  path.resolve(__dirname, '../../../../credentials/email-signature.html'),
].filter(Boolean) as string[];

const sigPath = candidates.find(p => fs.existsSync(p)) ?? null;
export let signatureHtml: string | null = null;

if (sigPath) {
  signatureHtml = fs.readFileSync(sigPath, 'utf-8');
  console.log('[emailSender] signature loaded from:', sigPath);
} else {
  console.error('[emailSender] signature not found. Tried:', candidates);
}

// Live signature edit (Settings tab): persist to the signature file AND reassign the
// in-memory handle so the very next send picks it up — no restart. Writes to the
// loaded-from path, or the configured/default path when none existed yet.
const sigWritePath = sigPath ?? env.EMAIL_SIGNATURE_PATH ?? path.resolve(process.cwd(), 'credentials/email-signature.html');
export function reloadSignature(html: string): void {
  fs.writeFileSync(sigWritePath, html, 'utf-8');
  signatureHtml = html;
  console.log('[emailSender] signature reloaded (live) →', sigWritePath);
}

const DAILY_CAP = 30;

function getTransport() {
  if (!env.GMAIL_FROM || !env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_FROM and GMAIL_APP_PASSWORD not configured');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: env.GMAIL_FROM, pass: env.GMAIL_APP_PASSWORD },
  });
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  businessId: string,
  country: string | null = null,
  verificationOverride = false,
  opts: { dryRun?: boolean; scheduledSendId?: string | null } = {},
): Promise<{ success: boolean; error?: string; remaining: number }> {
  if (!validateEmail(to)) {
    console.error('[emailSender] invalid email address:', to);
    return { success: false, error: 'Invalid email address', remaining: DAILY_CAP - getDailySendCount() };
  }

  const scheduledSendId = opts.scheduledSendId ?? null;

  // Dry-run: exercise cap/pacing/idempotency end-to-end but never transmit and
  // never mutate real state. Record a 'dryrun' row (excluded from real history /
  // analytics, which filter status='sent') and do NOT flip contacted-state.
  if (opts.dryRun) {
    console.log(`[scheduledSend] DRY-RUN transmit suppressed for ${businessId}`);
    recordEmailSend(businessId, 'dryrun', undefined, null, verificationOverride, scheduledSendId);
    return { success: true, remaining: DAILY_CAP - getDailySendCount() };
  }

  // Open-tracking pixel only when PUBLIC_URL is set (must be internet-reachable)
  const publicBase = env.PUBLIC_URL?.replace(/\/+$/, '') ?? null;
  const trackingToken = publicBase ? crypto.randomUUID() : null;

  try {
    const transport = getTransport();
    const pixel = trackingToken
      ? `<img src="${publicBase}/t/${trackingToken}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
      : '';
    const bodyHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222222;line-height:1.6;white-space:pre-wrap;">${body}</div>`;
    // Argentina keeps the /ar landing path; every other country gets the root site
    const sig = signatureHtml !== null && country !== 'Argentina'
      ? signatureHtml.replace('https://santiagovittor.store/ar', 'https://santiagovittor.store')
      : signatureHtml;
    await transport.sendMail({
      from: env.GMAIL_FROM,
      to,
      subject,
      text: body,
      ...(sig !== null || trackingToken !== null ? {
        html: bodyHtml + (sig !== null ? `<br><br>${sig}` : '') + pixel,
      } : {}),
    });
    recordEmailSend(businessId, 'sent', undefined, trackingToken, verificationOverride, scheduledSendId);
    markContacted(businessId);
    return { success: true, remaining: DAILY_CAP - getDailySendCount() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordEmailSend(businessId, 'failed', message, null, verificationOverride, scheduledSendId);
    return { success: false, error: message, remaining: DAILY_CAP - getDailySendCount() };
  }
}
