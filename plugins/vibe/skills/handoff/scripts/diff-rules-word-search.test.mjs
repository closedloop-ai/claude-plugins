import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { wordSearch } from "./diff-rules-repo.mjs";

// Each layout a whole-word search must classify like `git grep -l -w -F --untracked`, one word at a time; a symlink
// (link.ts) is never searched.
const LAYOUTS = {
  "prefix.ts": "fooBar foo\n",
  "inside.ts": "xfoo foox\n",
  "dollar-after.ts": "foo$ more\n",
  "dollar-before.ts": "$foo\n",
  "longer-only.ts": "fooBar\n",
  "colon: name.ts": "a foo b\n",
  "binary.bin": "\0bin foo\n",
  "second-on-line.ts": "barfoo baz foo\n",
  "underscore.ts": "foo_bar\n",
  "accent.ts": "caf\u00e9foo\n",
};
const UNTRACKED = { "untracked.ts": "foo\n" };
const WORDS = ["foo", "fooBar", "$foo", "foo_bar", "absent"];

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "word-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  for (const [file, text] of Object.entries(LAYOUTS)) writeFileSync(path.join(dir, file), text);
  symlinkSync("prefix.ts", path.join(dir, "link.ts"));
  git("add", ".");
  for (const [file, text] of Object.entries(UNTRACKED)) writeFileSync(path.join(dir, file), text);
  const single = (word) => {
    try { return git("grep", "-l", "-w", "-F", "--untracked", "-e", word).split("\n").filter(Boolean).sort(); }
    catch { return []; }
  };
  return { dir, single };
}

test("ISS-14116: one batched word search names the same files as a grep per word, for every layout", (t) => {
  const { dir, single } = repo(t);
  const search = wordSearch(dir);
  search.prefetchWords(WORDS);
  for (const word of WORDS) assert.deepEqual([...search.wordFiles(word)].sort(), single(word), word);
  assert.deepEqual([...search.wordFiles("foo")].sort(),
    ["accent.ts", "binary.bin", "colon: name.ts", "dollar-after.ts", "dollar-before.ts", "prefix.ts", "second-on-line.ts", "untracked.ts"]);
  assert.deepEqual(search.wordFiles("absent"), []);
});

test("ISS-14116: prefetched words cost one grep, not one per word", (t) => {
  const { dir } = repo(t);
  const calls = [];
  const search = wordSearch(dir, (args) => { calls.push(args); return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim(); });
  const words = Array.from({ length: 50 }, (_, index) => `word${index}`);
  search.prefetchWords([...words, "foo"]);
  for (const word of [...words, "foo"]) search.wordFiles(word);
  assert.equal(calls.length, 1);
  search.wordFiles("$foo");
  assert.equal(calls.length, 2, "a word with a non-word character is searched on its own");
});
