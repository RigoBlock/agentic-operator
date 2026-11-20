export declare const LIGHTER_ORDER_SENT_TOPIC: string;
export declare function extractLighterReqIdFromReceipt(receipt: { logs?: Array<{ topics?: string[] }> }): string | null;
