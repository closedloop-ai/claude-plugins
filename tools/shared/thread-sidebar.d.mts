export const WORKER_THREAD_SOURCE: "chatgpt_hidden";

export function labelWorkerThread(client: {
  request(method: string, params: unknown): Promise<any>;
}, threadId: string, name: string): Promise<string[]>;
