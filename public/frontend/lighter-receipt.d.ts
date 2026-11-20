export declare const LIGHTER_ORDER_SENT_TOPIC: string;
export declare function extractLighterReqIdFromReceipt(receipt: { logs?: Array<{ topics?: string[] }> }): string | null;
export declare function trackLighterRequest(
  reqId: string,
  appendMessage: (role: string, content: string) => void,
  attempt?: number,
): Promise<void>;
