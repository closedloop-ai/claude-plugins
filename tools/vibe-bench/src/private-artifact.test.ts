import assert from "node:assert/strict";
import test from "node:test";
import { privateReplyProblem, privateTextProblem } from "./private-artifact.ts";

test("ISS-14162 private text policy ignores slash text that is not an absolute path", () => {
  for (const value of [
    "run `claude /login` in Terminal (or type `/login` in Claude Code)",
    "Line 40 reads `{/* Agent draft (ISS-4410)",
    "open https://example.com/storybook/?path=/story/surfaces-dashboard--mid-run",
    "use `pointerdown`/`pointerup`",
    "plugins/vibe/tmp/out/reply.txt",
    "src/lib/var/etc/config.ts",
  ]) {
    assert.equal(privateTextProblem(value), null, value);
  }
});

test("ISS-14162 Q-14162-11 private text policy ignores system tool paths", () => {
  for (const value of ["`/usr/bin/git`", "/etc/hosts", "/bin/sh"]) {
    assert.equal(privateTextProblem(value), null, value);
  }
});

test("ISS-14162 private text policy still flags real absolute paths", () => {
  for (const value of [
    "/Users/someone/x",
    "/private/tmp/e-abc/out",
    "/home/u/repo",
    "saved at `/Users/someone/x`",
    "see (/home/u/repo/notes.md)",
    "out=/private/tmp/e-abc/out",
  ]) {
    assert.equal(privateTextProblem(value), "local-path", value);
  }
});

test("ISS-14116 reply policy accepts text the case input supplied and refuses novel paths", () => {
  const input = 'state {"storybookUrl": "http://localhost:6123"} file /Users/vibe-person/Desktop/board.png';
  assert.equal(privateReplyProblem("Open http://localhost:6123 to look.", input), null);
  assert.equal(privateReplyProblem("I cannot use `/Users/vibe-person/Desktop/board.png`.", input), null);
  assert.equal(privateReplyProblem("The file /Users/vibe-person/Desktop/board.png. Attach it instead.", input), null);
  assert.equal(privateReplyProblem("saved at /Users/someone/else.png", input), "absolute-path");
  assert.equal(privateReplyProblem("also /Users/vibe-person/Desktop/other.png", input), "absolute-path");
  assert.equal(privateReplyProblem("see /Users/vibe-person/Desktop/board.png and /private/tmp/e-abc/out", input),
    "absolute-path");
  assert.equal(privateReplyProblem("open file:///Users/vibe-person/x.html", input), "file-uri");
  assert.equal(privateReplyProblem("C:\\Users\\person\\reply", input), "absolute-path");
  assert.equal(privateReplyProblem("the box at 192.168.1.20", input), "hostname");
  assert.equal(privateReplyProblem("the box at 192.168.1.20", "ssh 192.168.1.20"), null);
  assert.equal(privateReplyProblem("Bearer secret-token-value", "Bearer secret-token-value"), "credential");
});

test("ISS-14116 reply policy lets a user-facing reply say laptop, localhost and local path", () => {
  for (const value of ["It is running on your laptop.", "Start it on localhost.",
    "That is a local path, so I cannot attach it."]) {
    assert.equal(privateReplyProblem(value), null, value);
    assert.equal(privateTextProblem(value), "local-path", `artifact context still refuses: ${value}`);
  }
});
