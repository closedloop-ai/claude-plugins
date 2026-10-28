import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscript, tokenTotals } from "./transcript-tokens.mjs";

const message = (id, usage) => ({ type: "assistant", message: { id, usage, content: [] } });

test("usage is counted once per message id across blocks and across transcripts", () => {
  const main = [
    message("m1", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }),
    message("m1", { input_tokens: 10, output_tokens: 5 }),
    message("m2", { input_tokens: 3, output_tokens: 2 }),
    { type: "result", duration_ms: 4000, total_cost_usd: 1.25, is_error: false },
  ];
  const subagent = [message("m2", { input_tokens: 3, output_tokens: 2 }), message("s1", { input_tokens: 1, output_tokens: 1 })];
  const { tokens, messages, result } = tokenTotals([main, subagent]);
  assert.deepEqual(tokens, { input: 14, output: 8, cacheRead: 100, cacheWrite: 7 });
  assert.equal(messages, 3);
  assert.deepEqual(result, { durationMs: 4000, costUsd: 1.25, isError: false });
});

test("a transcript without usage gives null tokens, not zeros", () => {
  const { tokens, messages, result } = tokenTotals([[{ type: "user" }, { type: "assistant", message: { id: "x", content: [] } }]]);
  assert.equal(tokens, null);
  assert.equal(messages, 0);
  assert.equal(result, null);
});

test("a result event missing its numbers reports them as null", () => {
  assert.deepEqual(tokenTotals([[{ type: "result" }]]).result, { durationMs: null, costUsd: null, isError: null });
});

test("blank and truncated lines are skipped", () => {
  const events = parseTranscript(`${JSON.stringify(message("a", { input_tokens: 1 }))}\n\n{"type":"assis`);
  assert.equal(events.length, 1);
});
