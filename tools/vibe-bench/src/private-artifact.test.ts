import assert from "node:assert/strict";
import test from "node:test";
import { privateTextProblem } from "./private-artifact.ts";

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
