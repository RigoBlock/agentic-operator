/**
 * Lighter Core request tracking.
 *
 * An EVM transaction receipt only proves submission. The actual outcome is
 * read from Lighter Core through READ_CORE (tx status 0x0000), using the
 * reqId carried by the adapter's indexed OrderSent event.
 */

import { callTool } from './api.js';

export { LIGHTER_ORDER_SENT_TOPIC, extractLighterReqIdFromReceipt } from './lighter-receipt-core.js';

/** Poll Core's request status and append the result to the chat. */
export async function trackLighterRequest(reqId, appendMessage, attempt = 0) {
  const { ok, data } = await callTool('lighter_get_request_status', {
    reqId: String(reqId),
  });
  if (!ok || !data) return;
  const text = data.message || data.error || 'Lighter Core status unavailable.';
  appendMessage('system', text);
  const pending = /pending|unknown|try again|check again/i.test(text) && !/success|failed|rejected/i.test(text);
  if (pending && attempt < 5) {
    setTimeout(() => trackLighterRequest(reqId, appendMessage, attempt + 1), 5000);
  }
}
