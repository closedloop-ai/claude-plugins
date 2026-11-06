import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evidenceTrace, failureDiagnostic } from "./stateful-claude-evidence.ts";
import { classifyUpgradeFailure, recordClaudeTurnOutput,
  statefulClaudeTerminalEvidence } from "./upgrade-resume-eval.ts";

test("ISS-13760 Claude terminal evidence keeps typed diagnostics and redacts private text", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-claude-terminal-"));
  try {
    const result = { exitCode: 0, stdout: `${JSON.stringify({ type: "system", subtype: "init",
      padding: "i".repeat(5000) })}\n` +
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text",
        text: "draft reply at file:///private/tmp/draft" }] } })}\n` +
      `{"type":"result","result":"Bash denied: Write unavailable"}\n`,
      stderr: "permission diagnostic\n" };
    const retained = readFileSync(recordClaudeTurnOutput(root, "turn-one", result), "utf8");
    assert.match(retained, /Bash denied: Write unavailable/);
    assert.ok(result.stdout.indexOf("Bash denied: Write unavailable") > 4_000);
    assert.doesNotMatch(retained, /file:\/\/\/private|draft reply/);
    assert.equal(JSON.parse(retained).stderr, "SANDBOX_REFUSAL");

    const nestedRoot = join(root, "nested");
    mkdirSync(nestedRoot);
    const nested = readFileSync(recordClaudeTurnOutput(nestedRoot, "turn-one", { exitCode: 1,
      stdout: `${JSON.stringify({ type: "secret-type", subtype: "secret-subtype",
        status: "secret-status", result: "permission denied cleaning owned record",
        errors: ["file:///private/tmp/secret", "ordinary private reply"],
        error: { status: "failed", type: "result",
          message: "AUTH_UNAVAILABLE: private-final-reply" } })}\n`,
      stderr: "ordinary stderr at file:///private/tmp/stderr" }), "utf8");
    assert.match(nested, /permission denied cleaning owned record/);
    assert.doesNotMatch(nested,
      /secret-type|secret-subtype|secret-status|file:\/\/\/private|ordinary private reply|private-final-reply|AUTH_UNAVAILABLE|ordinary stderr|"status":"failed"/);
    assert.equal(JSON.parse(nested).stderr, "[private text redacted]");
    const nestedEvent = JSON.parse(JSON.parse(nested).stdout);
    assert.deepEqual(nestedEvent.error, { status: "[private text redacted]",
      type: "[private text redacted]", message: "[private text redacted]" });

    for (const [diagnostic, expected] of [
      ["STALE_PLUGIN_ROOT", "STALE_PLUGIN_ROOT"],
      ["MODEL_BLOCKED", "MODEL_BLOCK"],
      ["AUTH_UNAVAILABLE: private-final-reply", "AUTH_UNAVAILABLE"],
      ["Selected model is at capacity", "MODEL_UNAVAILABLE"],
      ["sandbox approval required", "SANDBOX_REFUSAL"],
      ["timed out", "TIMEOUT"],
      ["MCP_TOOLS_MISSING", "INSTALL_INVALID"],
      ["wrong session", "WRONG_SESSION"],
      ["unclassified terminal failure", "ORACLE_MISMATCH"],
    ]) {
      const stream = statefulClaudeTerminalEvidence(
        JSON.stringify({ type: "result", subtype: "error", result: diagnostic }), 1);
      assert.equal(JSON.parse(stream).result, expected, diagnostic);
      assert.doesNotMatch(stream, /private-final-reply/);
    }
    assert.equal(failureDiagnostic(new Error("Bearer private-final-reply"),
      classifyUpgradeFailure), "[private text redacted]");
    const longPrivateReply = `private-start-${"x".repeat(5_000)}-private-end`;
    assert.deepEqual(evidenceTrace([`prefix ${longPrivateReply} suffix`], longPrivateReply),
      ["prefix [private reply redacted] suffix"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
