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
): Promise<{ success: boolean; error?: string; remaining: number }> {
  if (!validateEmail(to)) {
    console.error('[emailSender] invalid email address:', to);
    return { success: false, error: 'Invalid email address', remaining: DAILY_CAP - getDailySendCount() };
  }

  try {
    const transport = getTransport();
    await transport.sendMail({
      from: env.GMAIL_FROM,
      to,
      subject,
      text: body,
      ...(signatureHtml !== null ? {
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222222;line-height:1.6;white-space:pre-wrap;">${body}</div><br><br>${signatureHtml}`,
      } : {}),
    });
    recordEmailSend(businessId, 'sent');
    markContacted(businessId);
    return { success: true, remaining: DAILY_CAP - getDailySendCount() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordEmailSend(businessId, 'failed', message);
    return { success: false, error: message, remaining: DAILY_CAP - getDailySendCount() };
  }
}
