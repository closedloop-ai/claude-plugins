import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPublishableText } from "./publishable-text.mjs";
import { localPlanFiles, planDigest, renderSessionPlan, SELF_APPROVED_MARKER, sessionPlanEvidencePaths } from "./session-plan.mjs";
import { bindProviderInProcess, git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the provider this repository ships (spawned scripts inherit it).
bindProviderInProcess(after);

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-plan.mjs");
const TICKET_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../vibe-closedloop-provider/skills/closedloop-provider/references/agents/vibe-ticket-worker.md");
const ENVIRONMENT_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../vibe-closedloop-provider/skills/closedloop-provider/references/agents/vibe-environment-worker.md");
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
  const evidence = sessionPlanEvidencePaths(checkout, fixture.home);
  t.after(() => rmSync(evidence.root, { recursive: true, force: true }));
  const out = evidence.rendered;
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

test("ISS-14217: plan publication evidence uses one writable machine-private directory, never Git metadata", (t) => {
  const { home, checkout } = setup(t);
  const paths = sessionPlanEvidencePaths(checkout, home);
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], home);
  assert.equal(paths.root.startsWith(`${home}${path.sep}.codex${path.sep}vibe${path.sep}plan-evidence${path.sep}`), true, paths.root);
  assert.deepEqual(paths, {
    root: paths.root,
    rendered: path.join(paths.root, "vibe-live-plan.md"),
    published: path.join(paths.root, "vibe-live-plan-published.md"),
    planDocument: path.join(paths.root, "vibe-live-plan-document.json"),
    childEvidence: path.join(paths.root, "vibe-child-evidence.json"),
    liveTicket: path.join(paths.root, "vibe-live-ticket.md"),
    users: path.join(paths.root, "vibe-users"),
    flagSnapshot: path.join(paths.root, "vibe-flag-snapshot.new.json"),
    dispatchInputs: path.join(paths.root, "vibe-dispatch-inputs.json"),
    environmentResult: path.join(paths.root, "vibe-environment-result"),
    environmentResultFile: path.join(paths.root, "vibe-environment-result", "vibe-environment-result.json"),
    prBody: path.join(paths.root, "pr-body.md"),
    prEvidence: path.join(paths.root, "vibe-pr-evidence.json"),
    prEvidenceComment: path.join(paths.root, "pr-evidence-comment.md"),
  });
  for (const file of Object.values(paths)) assert.equal(file.startsWith(`${gitDir}${path.sep}`), false, file);

  const listed = runNode(SCRIPT, ["paths", "--worktree", checkout], home);
  assert.equal(listed.status, 0, JSON.stringify(listed.json));
  assert.deepEqual(listed.json, { ok: true, ...paths });
  assert.equal(existsSync(paths.users), true);
});

test("ISS-14217: provider workers resolve every direct evidence write through session-plan paths", () => {
  const workers = [
    [TICKET_WORKER, ["published", "planDocument", "childEvidence", "liveTicket", "users"]],
    [ENVIRONMENT_WORKER, ["flagSnapshot", "dispatchInputs", "environmentResult", "environmentResultFile", "liveTicket", "prBody", "prEvidence", "prEvidenceComment"]],
  ];
  for (const [file, fields] of workers) {
    const worker = readFileSync(file, "utf8");
    assert.match(worker, /session-plan\.mjs paths --worktree/, file);
    for (const field of fields) assert.match(worker, new RegExp(`<?${field}>?`), `${file}: ${field}`);
    assert.doesNotMatch(worker, /<gitdir>|rev-parse --absolute-git-dir|private git directory/, file);
  }
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
