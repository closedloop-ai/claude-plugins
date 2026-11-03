import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "reference-images.mjs");
// A 1x1 PNG and a 1x1 GIF, enough for the signature check.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function session(t) {
  const fixture = makeHome("reference-images-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "session");
  mkdirSync(worktree);
  git(worktree, ["init", "--quiet", "--initial-branch=vibe/test"], fixture.home);
  const metadata = git(worktree, ["rev-parse", "--absolute-git-dir"], fixture.home);
  writeFileSync(path.join(metadata, "vibe-session.json"), JSON.stringify({ worktree, branch: "vibe/test" }));
  return { ...fixture, worktree, metadata };
}

function record(metadata) {
  return JSON.parse(readFileSync(path.join(metadata, "vibe-session.json"), "utf8"));
}

test("saves a given image file privately, records it on the session once, and refuses a non-image", (t) => {
  const { root, home, worktree, metadata } = session(t);
  const file = path.join(root, "reference.png");
  writeFileSync(file, PNG);
  const first = runNode(SCRIPT, ["save", "--worktree", worktree, "--file", file, "--request-id", "req-1"], home);
  assert.equal(first.status, 0, first.stdout);
  const [entry] = first.json.saved;
  assert.equal(entry.mediaType, "image/png");
  assert.equal(entry.source, "file");
  assert.equal(entry.requestId, "req-1");
  assert.equal(path.dirname(entry.path), path.join(metadata, "vibe-reference-images"));
  assert.deepEqual(readFileSync(entry.path), PNG);
  assert.equal(statSync(entry.path).mode & 0o777, 0o600);
  const again = runNode(SCRIPT, ["save", "--worktree", worktree, "--file", file], home);
  assert.equal(again.status, 0);
  assert.equal(record(metadata).referenceImages.length, 1);
  const text = path.join(root, "notes.txt");
  writeFileSync(text, "a description of the screenshot");
  const refused = runNode(SCRIPT, ["save", "--worktree", worktree, "--file", text], home);
  assert.equal(refused.status, 1);
  assert.match(refused.json.error, /Not a PNG, JPEG, GIF or WebP image/);
  assert.equal(record(metadata).referenceImages.length, 1);
});

test("decodes the person's latest attached image from a Claude Code transcript, never a tool screenshot", (t) => {
  const { root, home, worktree, metadata } = session(t);
  const claudeHome = path.join(root, "claude");
  const projects = path.join(claudeHome, "projects", "-session");
  mkdirSync(projects, { recursive: true });
  const image = (bytes, type) => ({ type: "image", source: { type: "base64", media_type: type, data: bytes.toString("base64") } });
  const lines = [
    { type: "user", message: { role: "user", content: [{ type: "text", text: "older [Image #1]" }, image(GIF, "image/gif")] } },
    { type: "user", toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", content: [image(GIF, "image/gif")] }] } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "make it look like this [Image #2]" }, image(PNG, "image/png")] } },
    { type: "user", toolUseResult: {}, message: { role: "user", content: [image(GIF, "image/gif")] } },
  ];
  writeFileSync(path.join(projects, "11111111-2222-4333-8444-555555555555.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
  const result = runNode(SCRIPT, ["attached", "--worktree", worktree, "--request-id", "req-2"], home, {
    CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-555555555555", CODEX_THREAD_ID: "",
  });
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.saved.length, 1);
  assert.equal(result.json.saved[0].source, "attachment");
  assert.deepEqual(readFileSync(result.json.saved[0].path), PNG);
  assert.deepEqual(record(metadata).referenceImages.map((entry) => entry.mediaType), ["image/png"]);
});

test("decodes attached images from the Codex rollout of this thread, and every message with --all", (t) => {
  const { root, home, worktree, metadata } = session(t);
  const codexHome = path.join(root, "codex");
  const day = path.join(codexHome, "sessions", "2026", "10", "15");
  mkdirSync(day, { recursive: true });
  const thread = "01a13656-91fe-75f0-81fa-c3f941e9ae56";
  const dataUrl = (bytes, type) => `data:${type};base64,${bytes.toString("base64")}`;
  const lines = [
    { type: "session_meta", payload: { id: thread } },
    { type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: "like this" }, { type: "input_image", image_url: dataUrl(GIF, "image/gif") }] } },
    { type: "response_item", payload: { type: "custom_tool_call_output",
      output: [{ type: "input_image", image_url: dataUrl(PNG, "image/png") }] } },
    { type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_image", image_url: dataUrl(PNG, "image/png") }] } },
  ];
  writeFileSync(path.join(day, `rollout-2026-10-15T10-00-00-${thread}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n"));
  const env = { CODEX_HOME: codexHome, CODEX_THREAD_ID: thread, CLAUDE_CODE_SESSION_ID: "" };
  const latest = runNode(SCRIPT, ["attached", "--worktree", worktree], home, env);
  assert.equal(latest.status, 0, JSON.stringify(latest.json));
  assert.deepEqual(latest.json.saved.map((entry) => entry.mediaType), ["image/png"]);
  const all = runNode(SCRIPT, ["attached", "--worktree", worktree, "--all"], home, env);
  assert.equal(all.status, 0);
  assert.deepEqual(record(metadata).referenceImages.map((entry) => entry.mediaType).sort(), ["image/gif", "image/png"]);
  const list = runNode(SCRIPT, ["list", "--worktree", worktree], home);
  assert.equal(list.json.referenceImages.length, 2);
});

test("fails plainly when the transcript holds no image the person attached", (t) => {
  const { root, home, worktree } = session(t);
  const transcript = path.join(root, "transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "words only" } })}\n`);
  const result = runNode(SCRIPT, ["attached", "--worktree", worktree, "--transcript", transcript], home);
  assert.equal(result.status, 1);
  assert.match(result.json.error, /no image the person attached/);
});
