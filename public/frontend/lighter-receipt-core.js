export const LIGHTER_ORDER_SENT_TOPIC =
  '0xb35827c397d4677400cf039132506992d54c18249a9ca2a2516bfcca3afec7f5';

/** Extract the Core reqId from an indexed OrderSent event, or null. */
export function extractLighterReqIdFromReceipt(receipt) {
  if (!receipt?.logs) return null;
  for (const log of receipt.logs) {
    if (log.topics?.[0] === LIGHTER_ORDER_SENT_TOPIC && log.topics.length >= 2) {
      try {
        return BigInt(log.topics[1]).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}
