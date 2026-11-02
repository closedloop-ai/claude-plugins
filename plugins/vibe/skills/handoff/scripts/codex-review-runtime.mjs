// Read a managed Codex reviewer's exact completed turn from App Server.
// Its saved MCP items have type mcpToolCall with server, tool and status:
// https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/thread_history.rs
import { connectViaProxy, daemonSocket } from "../../codex-fleet-monitor/scripts/liveness.mjs";

/** Completed turn and machine-observed successful MCP calls, or a refusal. */
export function observedCodexTurn(thread, sessionId, turnId) {
  if (thread?.id !== sessionId) throw new Error("App Server returned another native reviewer thread");
  const turn = Array.isArray(thread.turns) ? thread.turns.find(item => item?.id === turnId) : null;
  if (turn?.status !== "completed" || !Array.isArray(turn.items) || turn.itemsView === "notLoaded") {
    throw new Error("App Server has no loaded completed reviewer turn and items");
  }
  const toolCalls = turn.items.filter(item => item?.type === "mcpToolCall" && item.status === "completed"
    && typeof item.server === "string" && typeof item.tool === "string")
    .map(item => `mcp__${item.server}__${item.tool}`);
  return { sessionId, turnId, status: "completed", toolCalls };
}

/** Read one exact thread through the repository's existing App Server client. */
export async function readCodexReviewTurn(sessionId, turnId, client) {
  const owned = client ?? connectViaProxy(daemonSocket());
  try {
    if (!client) await owned.initialize();
    const { thread } = await owned.request("thread/read", { threadId: sessionId, includeTurns: false });
    let cursor;
    let turn = null;
    do {
      const page = await owned.request("thread/turns/list", { threadId: sessionId, limit: 50, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) });
      turn = (page?.data ?? []).find(item => item?.id === turnId) ?? turn;
      cursor = turn ? null : page?.nextCursor ?? null;
    } while (cursor);
    if (!turn || turn.status !== "completed") throw new Error("App Server did not return the exact completed reviewer turn");
    const items = [];
    cursor = undefined;
    do {
      const page = await owned.request("thread/items/list", { threadId: sessionId, turnId, limit: 100, sortDirection: "asc", ...(cursor ? { cursor } : {}) });
      items.push(...(page?.data ?? []).map(entry => entry?.item).filter(Boolean));
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    return observedCodexTurn({ ...thread, turns: [{ ...turn, items }] }, sessionId, turnId);
  } finally { if (!client) owned.close(); }
}
