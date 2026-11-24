/** Tool calls and runtime identities recovered from the owned worker's JSONL trace. */
export function reviewTraceFacts(traceText: string): { toolCalls: string[]; sessionId: string | null; model: string | null };
/** Tool calls made through a graph capability explicitly granted to the worker. */
export function graphCalls(result: { graphToolAliases: string[] }, trace: { toolCalls: string[] }): string[];
