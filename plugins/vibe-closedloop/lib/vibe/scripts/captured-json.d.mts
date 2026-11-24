/** Decode one complete machine response. Callers validate its schema. */
export function capturedJson(input: string | Buffer): unknown;
/** Decode ordered NDJSON or concatenated complete documents. */
export function capturedJsonDocuments(input: string | Buffer): unknown[];
