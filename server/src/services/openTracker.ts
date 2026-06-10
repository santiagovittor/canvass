import { findSendByToken, insertEmailOpen } from '../db';
import { broadcast } from '../sse';

export function recordOpen(token: string, userAgent: string | null): void {
  try {
    const send = findSendByToken(token);
    if (!send) return;
    insertEmailOpen(send.id, send.business_id, userAgent);
    broadcast('email:opened', { businessId: send.business_id });
  } catch (err) {
    console.error('[openTracker]', err);
  }
}
