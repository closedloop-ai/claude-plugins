import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleDirectory, fixture, graph, liveReads } from "./test-fixtures.js";

// A 1x1 PNG: the person's attached reference, already in the harness transcript.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const referenceScript = resolve(bundleDirectory, "../reference-images.mjs");
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

/** Saves the attached image through the production script, exactly as the orchestrator does. */
function attachReference(value: ReturnType<typeof fixture>) {
  const transcript = join(value.base, "transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: [
    { type: "text", text: "make the card look like this [Image #1]" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] } })}\n`);
  const saved = JSON.parse(execFileSync(process.execPath, [referenceScript, "attached", "--worktree", value.worktree,
    "--transcript", transcript, "--request-id", "first"], { encoding: "utf8" }));
  expect(saved.ok).toBe(true);
  return saved.saved[0].path as string;
}

function launch(value: ReturnType<typeof fixture>, agentName: string, requestId: string) {
  const capabilities = agentName === "vibe-requirements-worker" ? [...graph, ...liveReads] : graph;
  return spawnSync(process.execPath, [join(bundleDirectory, "claude-worker.mjs")], {
    input: JSON.stringify({ worktree: value.worktree, agentRoot: value.agentRoot, agentName, capabilities,
      mode: "request", requestId, input: "Build the card from the reference" }),
    encoding: "utf8", env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` }, timeout: 10000,
  });
}

function payloads(value: ReturnType<typeof fixture>) {
  return readFileSync(join(value.metadata, "fake-proof.jsonl"), "utf8").trim().split("\n")
    .map((line) => (JSON.parse(line) as { payload: { referenceImages?: { path: string; mediaType: string }[] } }).payload);
}

describe("reference images reach the writer as files it opens", () => {
  it("names the attached image's saved path in the Claude writer and requirements turns, not in other roles", () => {
    const value = fixture();
    fixtures.push(value);
    const saved = attachReference(value);
    expect(readFileSync(saved).toString("base64")).toBe(PNG);
    expect(launch(value, "vibe-change-worker", "first").status).toBe(0);
    expect(launch(value, "vibe-requirements-worker", "reference").status).toBe(0);
    expect(launch(value, "vibe-guardrails-reviewer", "review").status).toBe(0);
    const [writer, requirements, reviewer] = payloads(value);
    expect(writer?.referenceImages).toEqual([{ path: saved, mediaType: "image/png", requestId: "first" }]);
    expect(requirements?.referenceImages).toEqual(writer?.referenceImages);
    expect(reviewer?.referenceImages).toBeUndefined();
  }, 20000);

  it("leaves out a recorded path outside the session's reference folder or a deleted file", () => {
    const value = fixture();
    fixtures.push(value);
    const saved = attachReference(value);
    const recordFile = join(value.metadata, "vibe-session.json");
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    const outside = join(value.base, "elsewhere.png");
    writeFileSync(outside, Buffer.from(PNG, "base64"));
    record.referenceImages.push({ path: outside, mediaType: "image/png" },
      { path: join(value.metadata, "vibe-reference-images", "missing.png"), mediaType: "image/png" }, { path: 3 });
    writeFileSync(recordFile, JSON.stringify(record));
    expect(launch(value, "vibe-change-worker", "first").status).toBe(0);
    expect(payloads(value)[0]?.referenceImages?.map((image) => image.path)).toEqual([saved]);
  }, 20000);

  it("returns the saved paths with the Codex writer's claimed input, and nothing when none were saved", () => {
    const value = fixture();
    fixtures.push(value);
    const cli = (action: string, input: unknown) => JSON.parse(execFileSync(process.execPath,
      [join(bundleDirectory, "writer-state.mjs"), action], { input: JSON.stringify(input), encoding: "utf8" }));
    const registration = cli("register", { worktree: value.worktree, runtime: "codex", workerId: "native-reference",
      agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph });
    const input = { worktree: value.worktree, workerId: registration.workerId, requestId: "codex-request" };
    cli("enqueue", { ...input, input: "Build the card from the reference" });
    const lease = cli("claim", input).turn.lease;
    expect(cli("take-input", { ...input, lease }).referenceImages).toBeUndefined();
    const saved = attachReference(value);
    expect(cli("take-input", { ...input, lease }).referenceImages).toEqual([
      { path: saved, mediaType: "image/png", requestId: "first" }]);
  }, 20000);
});
