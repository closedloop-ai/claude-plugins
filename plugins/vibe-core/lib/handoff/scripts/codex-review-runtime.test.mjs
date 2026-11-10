import assert from "node:assert/strict";
import test from "node:test";
import { observedCodexTurn, readCodexReviewTurn } from "./codex-review-runtime.mjs";
import { graphAliases } from "./mcp-tool-names.mjs";

test("managed Codex reviewer calls come only from its completed App Server turn items", async () => {
  const thread = { id: "thread-1", turns: [{ id: "turn-1", status: "completed", items: [
    { type: "mcpToolCall", server: "custom_graph", tool: "sync-status", status: "completed" },
    { type: "mcpToolCall", server: "custom_graph", tool: "claimed-only", status: "failed" },
    { type: "agentMessage", text: "I called another tool" },
  ] }] };
  assert.deepEqual(observedCodexTurn(thread, "thread-1", "turn-1"), {
    sessionId: "thread-1", turnId: "turn-1", status: "completed", toolCalls: ["mcp__custom_graph__sync-status"],
  });
  const calls = [];
  let turnPages = 0;
  const client = { request: async (method, args) => {
    calls.push([method, args]);
    if (method === "thread/read") return { thread: { id: "thread-1" } };
    if (method === "thread/turns/list" && turnPages++ === 0) return { data: [{ id: "other", status: "completed" }], nextCursor: "turn-next" };
    if (method === "thread/turns/list") return { data: [{ id: "turn-1", status: "completed", itemsView: "notLoaded" }] };
    if (method === "thread/items/list" && !args.cursor) return { data: [{ item: thread.turns[0].items[0] }], nextCursor: "next" };
    if (method === "thread/items/list") return { data: thread.turns[0].items.slice(1).map(item => ({ item })) };
    throw new Error(method);
  } };
  assert.deepEqual(await readCodexReviewTurn("thread-1", "turn-1", client), observedCodexTurn(thread, "thread-1", "turn-1"));
  assert.equal(calls.some(([method, args]) => method === "thread/read" && args.includeTurns === true), false);
  assert.equal(calls.filter(([method]) => method === "thread/turns/list").length, 2, "turn pages are read until the exact turn");
  assert.equal(calls.filter(([method]) => method === "thread/items/list").length, 2, "all item pages are read");
  assert.throws(() => observedCodexTurn(thread, "other", "turn-1"), /another native reviewer thread/);
  assert.throws(() => observedCodexTurn({ ...thread, turns: [{ ...thread.turns[0], status: "inProgress" }] }, "thread-1", "turn-1"), /no loaded completed/);
  assert.throws(() => observedCodexTurn({ ...thread, turns: [{ ...thread.turns[0], items: [], itemsView: "notLoaded" }] }, "thread-1", "turn-1"), /no loaded completed/);
});

test("native reviewer receipt refuses absent items after a completed summary", async () => {
  const summary = { id: "turn-1", status: "completed", itemsView: "notLoaded" };
  const thread = { id: "thread-1", turns: [summary] };
  assert.throws(() => observedCodexTurn(thread, "thread-1", "turn-1"), /no loaded completed/);
  assert.throws(() => observedCodexTurn({ ...thread, turns: [{ ...summary, items: [{ type: "agentMessage" }] }] }, "thread-1", "turn-1"), /no loaded completed/);
  const client = { request: async (method) => {
    if (method === "thread/read") return { thread: { id: "thread-1" } };
    if (method === "thread/turns/list") return { data: [summary] };
    if (method === "thread/items/list") return { data: [] };
    throw new Error(method);
  } };
  await assert.rejects(readCodexReviewTurn("thread-1", "turn-1", client), /no loaded completed/);
});

test("native MCP server separators match recorded aliases without trusting command text", () => {
  const observed = observedCodexTurn({ id: "thread-1", turns: [{ id: "turn-1", status: "completed", items: [
    { type: "mcpToolCall", server: "closedloop-graph", tool: "code_symbols", status: "completed" },
    { type: "mcpToolCall", server: "closedloop_graph", tool: "code_importers", status: "completed" },
    { type: "mcpToolCall", server: "closedloop-other", tool: "code_symbols", status: "completed" },
    { type: "mcpToolCall", server: "closedloop-graph", tool: "code_callers", status: "failed" },
    { type: "mcpToolCall", server: "closedloop-graph", tool: "code_symbols_extra", status: "completed" },
    { type: "commandExecution", status: "completed", command: "tools.mcp__closedloop_graph__code_callers({})" },
    { type: "agentMessage", text: "I used mcp__closedloop_graph__code_callers" },
  ] }] }, "thread-1", "turn-1");
  const aliases = graphAliases([
    { name: "mcp__closedloop_graph__code_symbols", service: "graph", operation: "code_symbols", access: "read" },
    { name: "mcp__closedloop_graph__code_importers", service: "graph", operation: "code_importers", access: "read" },
    { name: "mcp__closedloop_graph__code_callers", service: "graph", operation: "code_callers", access: "read" },
  ]);

  assert.deepEqual(observed.toolCalls.filter(name => aliases.includes(name)), [
    "mcp__closedloop_graph__code_symbols",
    "mcp__closedloop_graph__code_importers",
  ]);
  assert.ok(!observed.toolCalls.includes("mcp__closedloop_graph__code_callers"), "failed calls and command text do not count");
  assert.ok(observed.toolCalls.includes("mcp__closedloop_other__code_symbols"), "a different server remains distinct");
  assert.ok(observed.toolCalls.includes("mcp__closedloop_graph__code_symbols_extra"), "a different operation remains distinct");
});
