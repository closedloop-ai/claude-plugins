import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPublishableText } from "./publishable-text.mjs";
import { localPlanFiles, planDigest, renderSessionPlan, SELF_APPROVED_MARKER } from "./session-plan.mjs";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-plan.mjs");
const WORKTREE = "/Users/vibe-person/symphony-alpha/.claude/worktrees/vibe-board";
const CHECKOUT = "/Users/vibe-person/symphony-alpha";

function kinds(text, context = {}) {
  return checkPublishableText(text, context).problems.map((problem) => problem.kind);
}

function setup(t) {
  const fixture = makeHome("session-plan-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.root, "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout });
  const out = path.join(git(checkout, ["rev-parse", "--absolute-git-dir"], fixture.home), "vibe-live-plan.md");
  return { ...fixture, checkout, out };
}

function writePlan(checkout, name, content) {
  const file = path.join(checkout, ".closedloop-ai/vibe-plans", name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

test("a path in the session's own checkout becomes repo-relative and nothing is refused", () => {
  const result = checkPublishableText(
    `Edit \`${WORKTREE}/apps/app/board.tsx\` and ${CHECKOUT}/packages/app/chip.tsx.\n`,
    { roots: [CHECKOUT, WORKTREE], privateWords: ["vibe-person"] },
  );
  assert.equal(result.text, "Edit `apps/app/board.tsx` and packages/app/chip.tsx.\n");
  assert.deepEqual(result.problems, []);
});

test("a local absolute path outside the checkout is refused with its line, never echoed", () => {
  const result = checkPublishableText("# Plan\n\nRead /Users/vibe-person/Downloads/notes.txt first.\n", {
    roots: [WORKTREE],
  });
  assert.deepEqual(result.problems, [{ line: 3, kind: "local absolute path" }]);
  assert.ok(!JSON.stringify(result.problems).includes("Downloads"));
  for (const local of ["~/.codex/vibe/config.json", "/tmp/session/out.json", "/home/someone/x", "C:\\Users\\someone\\x"]) {
    assert.deepEqual(kinds(`see ${local}`), ["local absolute path"], local);
  }
  assert.deepEqual(kinds("The route is /settings/profile and the API is /api/tags."), []);
});

test("the local username, personal emails, secrets and private session inputs are refused", () => {
  assert.deepEqual(kinds("Ask vibe-person.", { privateWords: ["vibe-person"] }), ["local username"]);
  assert.deepEqual(kinds("Owner: someone@closedloop.ai"), ["personal email address"]);
  assert.deepEqual(kinds("Fixture user owner@example.invalid, package react@18.3.1."), []);
  assert.deepEqual(kinds("export STRIPE=sk_live_abcdefghijklmnop"), ["secret key"]);
  assert.deepEqual(kinds("token ghp_abcdefghijklmnopqrstuvwxyz0123"), ["GitHub token"]);
  assert.deepEqual(kinds("apiKey: \"a1b2c3d4e5f6g7h8i9j0\""), ["assigned secret"]);
  assert.deepEqual(kinds("apiKey: process.env.CLOSEDLOOP_API_KEY"), []);
  assert.deepEqual(kinds("http://127.0.0.1:4000/design-system/browser.html?closedloopBridgeToken=abcdefghijklmnop"),
    ["credential in a URL"]);
  assert.deepEqual(kinds("Read the queued request from vibe-writer.json."), ["private session input"]);
});

test("bare angle-bracketed names become code spans outside code, and code is left alone", () => {
  const result = checkPublishableText("Use <TagMenu> in `<Board>`.\n\n```tsx\n<TagMenu />\n```\n");
  assert.equal(result.text, "Use `<TagMenu>` in `<Board>`.\n\n```tsx\n<TagMenu />\n```\n");
});

test("plans are the top-level markdown files in request ID order; subfolders stay local", (t) => {
  const { checkout } = setup(t);
  assert.deepEqual(localPlanFiles(checkout), []);
  writePlan(checkout, "request-10.md", "# Ten\n");
  writePlan(checkout, "request-2.md", "# Two\n");
  writePlan(checkout, "review/request-2-draft.md", "# Draft\n");
  writePlan(checkout, "notes.txt", "not a plan\n");
  assert.deepEqual(localPlanFiles(checkout), [".closedloop-ai/vibe-plans/request-2.md", ".closedloop-ai/vibe-plans/request-10.md"]);
  const rendered = renderSessionPlan(checkout, { roots: [checkout] });
  assert.equal(rendered.body, `${SELF_APPROVED_MARKER}\n\n# Two\n\n---\n\n# Ten\n`);
  assert.deepEqual(rendered.problems, []);
});

test("the digest ignores whitespace-only edits and changes with content", () => {
  assert.equal(planDigest("# Plan\n\n\n\n- one  \n"), planDigest("# Plan\n\n- one\n"));
  assert.notEqual(planDigest("# Plan\n- one\n"), planDigest("# Plan\n- two\n"));
});

test("the CLI writes the sanitized body and reports whether the published version is current", (t) => {
  const { home, checkout, out } = setup(t);
  const empty = runNode(SCRIPT, ["--worktree", checkout, "--out", out], home);
  assert.equal(empty.status, 0);
  assert.equal(empty.json.empty, true);
  writePlan(checkout, "request-1.md", `# Implementation Plan: Board chips\n\nChange \`${checkout}/apps/app/board.tsx\`.\n`);
  const first = runNode(SCRIPT, ["--worktree", checkout, "--out", out], home);
  assert.equal(first.status, 0, JSON.stringify(first.json));
  assert.equal(readFileSync(out, "utf8"), `${SELF_APPROVED_MARKER}\n\n# Implementation Plan: Board chips\n\nChange \`apps/app/board.tsx\`.\n`);
  const published = path.join(path.dirname(out), "vibe-live-plan-published.md");
  writeFileSync(published, `${SELF_APPROVED_MARKER}\n\n# Implementation Plan: Board chips\n\n\nChange \`apps/app/board.tsx\`.   \n`);
  assert.equal(runNode(SCRIPT, ["--worktree", checkout, "--out", out, "--published", published], home).json.current, true);
  writePlan(checkout, "request-2.md", "# Implementation Plan: Selected chip fill\n");
  assert.equal(runNode(SCRIPT, ["--worktree", checkout, "--out", out, "--published", published], home).json.current, false);
});

test("the CLI refuses a plan with a local path, writes nothing and names the file and line", (t) => {
  const { home, checkout, out } = setup(t);
  writePlan(checkout, "request-1.md", "# Plan\n\nCopy /Users/vibe-person/Desktop/shot.png into the story.\n");
  const result = runNode(SCRIPT, ["--worktree", checkout, "--out", out], home);
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.problems, [{ file: ".closedloop-ai/vibe-plans/request-1.md", line: 3, kind: "local absolute path" }]);
  assert.throws(() => readFileSync(out), /ENOENT/);
});

test("a symlinked plan is refused rather than followed", (t) => {
  const { home, root, checkout, out } = setup(t);
  writeFileSync(path.join(root, "outside.md"), "# Outside\n");
  mkdirSync(path.join(checkout, ".closedloop-ai/vibe-plans"), { recursive: true });
  symlinkSync(path.join(root, "outside.md"), path.join(checkout, ".closedloop-ai/vibe-plans/request-1.md"));
  const result = runNode(SCRIPT, ["--worktree", checkout, "--out", out], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.problems[0].kind, "plan is a symlink");
});
