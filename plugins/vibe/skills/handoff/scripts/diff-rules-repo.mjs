// The git-backed repository diff-rules.mjs's rules read: head and base file text, base blobs through one
// `git cat-file --batch`, whole-word file search, importers by path, history lookups for deletions and unmounts,
// and the shallow-clone deepening steps. Git reads and file reads only.

import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { E2E_ROOT_PATHSPECS, isTestFile } from "../../vibe/scripts/test-files.mjs";
import { escapeRegExp } from "./source-imports.mjs";
import { linguistGenerated } from "./generated-files.mjs";
import { FROZEN_CANDIDATE, frozenInputs } from "./frozen-render.mjs";
import { isUnversionedStory, storybookSchemeOf } from "./storybook-taxonomy.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");

const WORD_TOKEN = /^[A-Za-z0-9_]+$/;
const WORD_TOKENS = /[A-Za-z0-9_]+/g;
const WORD_BATCH = 200;
const TEMPLATE_PART = /\$\{[^}]*\}/;
export const DEEPEN_STEPS = ["--deepen=1000", "--deepen=10000", "--unshallow"];
const DEEPEN_TIMEOUT_MS = 10 * 60 * 1000;

export function gitRepo(worktree, base, isFrozenStory, storyReplacements, rules, sessionIds = [], storyOrderPath = null) {
  let deepened = 0;
  const headFiles = readGitInventory(worktree, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const baseObjects = new Map(readGitInventory(worktree, ["ls-tree", "-r", "-z", base]).split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode, , oid] = entry.slice(0, tab).split(" ");
    return [entry.slice(tab + 1), { mode, oid }];
  }));
  const baseFiles = new Set(baseObjects.keys());
  const generatedFiles = linguistGenerated(worktree, headFiles, base);
  const blobs = new Map();
  const baseBlobs = (paths) => {
    const missing = [...new Set(paths)].filter((file) => !blobs.has(file) && baseFiles.has(file));
    if (missing.length) {
      readBlobs(worktree, base, missing).forEach((text, file) => blobs.set(file, text));
    }
    return new Map(paths.map((file) => [file, blobs.get(file)]));
  };
  const read = memoize((file) => {
    const absolute = path.join(worktree, file);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  });
  const words = wordSearch(worktree);
  const baseRead = memoize((file) => {
    try {
      return git(worktree, ["show", `${base}:${file}`]);
    } catch {
      return null;
    }
  });
  const scheme = storybookSchemeOf(storyOrderPath ? baseRead(storyOrderPath) : null);
  const frozenStory = isFrozenStory ?? ((source) => scheme.frozenTitle(source) || scheme.frozenTag(source));
  return {
    head: read,
    base: baseRead,
    baseCommit: base,
    shallow: () => lines(() => git(worktree, ["rev-parse", "--is-shallow-repository"]))[0] === "true",
    deepen: () => {
      const step = DEEPEN_STEPS[deepened++] ?? "--unshallow";
      try {
        execFileSync("git", ["-C", worktree, "fetch", "--quiet", step], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: DEEPEN_TIMEOUT_MS });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: `git fetch ${step}: ${String(error?.stderr ?? error?.message ?? error).trim().split("\n")[0]}` };
      }
    },
    headFiles,
    baseFiles,
    baseObjects,
    headRegularBlob: (file, oidLength) => {
      const absolute = path.join(worktree, file);
      try {
        const stat = lstatSync(absolute);
        if (!stat.isFile()) return null;
        const bytes = readFileSync(absolute);
        const oid = createHash(oidLength === 64 ? "sha256" : "sha1")
          .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        return { mode: stat.mode & 0o111 ? "100755" : "100644", oid };
      } catch {
        return null;
      }
    },
    generatedFiles,
    baseBlobs,
    wordFiles: words.wordFiles,
    prefetchWords: words.prefetchWords,
    sessionIds,
    storyReplacements,
    deletionOf: (file) => {
      const hit = lines(() => git(worktree, ["log", "--diff-filter=D", "-n", "1", "--format=%h %s", base, "--", file]))[0];
      return hit ? `commit ${hit}` : null;
    },
    unmountOf: (name, file) => {
      const mount = new RegExp(`<${name}\\b`);
      for (const hit of lines(() => git(worktree, ["log", "-G", `<${name}([^A-Za-z0-9]|$)`, "-n", "20", "--format=%H %h %s", base, "--", file]))) {
        const [sha, ...summary] = hit.split(" ");
        const diff = lines(() => git(worktree, ["show", "--format=", "--unified=0", sha, "--", file]));
        const count = (sign) => diff.filter((text) => text.startsWith(sign) && !text.startsWith(`${sign}${sign}${sign}`) && mount.test(text)).length;
        if (count("-") > count("+")) {
          return `commit ${summary.join(" ")}`;
        }
      }
      return null;
    },
    baseContains: (text) => {
      const parts = text.split(TEMPLATE_PART);
      const search = parts.length > 1 ? ["-E", "-e", parts.map((part) => part.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&")).join(".*")] : ["-F", "-e", text];
      try {
        git(worktree, ["grep", "-q", ...search, base]);
        return true;
      } catch {
        return false;
      }
    },
    frozenInputs: (ref, stories) => { try { return frozenInputs(worktree, ref, stories); } catch { return null; } },
    filesNaming: (text) => lines(() => git(worktree, ["grep", "-l", "-F", text, "--", ...E2E_ROOT_PATHSPECS, ...rules.docs, "*.test.*", "*.spec.*", "*.stories.*"])),
    rules,
    isFrozenStory: frozenStory,
    frozenStories: () => {
      const candidates = lines(() => git(worktree, ["grep", "-l", "-E", FROZEN_CANDIDATE, base, "--", "*.stories.tsx", "*.stories.ts"]))
        .map((hit) => hit.slice(base.length + 1));
      const texts = baseBlobs(candidates);
      return candidates.filter((story) => !isUnversionedStory(texts.get(story)) && frozenStory(texts.get(story) ?? ""));
    },
    baseStoriesRendering: (component) =>
      lines(() => git(worktree, ["grep", "-l", "-E", `component:[[:space:]]*${component}([^[:alnum:]_]|$)`, base, "--", "*.stories.tsx", "*.stories.ts"]))
        .map((hit) => hit.slice(base.length + 1)),
    importersOf: (files) => importersOf(worktree, files),
    importerCounts: (files) => new Map([...importersOf(worktree, files)].map(([file, importing]) => [file, [...importing].filter((hit) => !isTestFile(hit)).length])),
  };
}

/** Recognize one-to-one exact regular-file moves where Git left a different file at the old path. */
export function exactReplacedMoves(files, repo) {
  const added = files.filter((file) => file.status === "A" && file.added.length > 0);
  if (!added.length || !repo.baseObjects || !repo.headRegularBlob) return files;
  const originals = new Map();
  const identity = (blob) => `${blob.mode} ${blob.oid}`;
  for (const file of files) {
    if (file.status !== "M") continue;
    const prior = repo.baseObjects.get(file.path);
    if (!prior || !/^100(?:644|755)$/.test(prior.mode)) continue;
    const next = repo.headRegularBlob(file.path, prior.oid.length);
    if (!next || prior.oid === next.oid) continue;
    const key = identity(prior);
    originals.set(key, originals.has(key) ? null : file.path);
  }
  if (originals.size === 0) return files;
  const candidates = new Map();
  const count = new Map();
  const oidLength = repo.baseObjects.values().next().value?.oid.length;
  for (const file of added) {
    const blob = repo.headRegularBlob(file.path, oidLength);
    if (!blob) continue;
    const key = identity(blob);
    if (!originals.get(key)) continue;
    candidates.set(file.path, key);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return files.map((file) => {
    const key = candidates.get(file.path);
    return count.get(key) === 1 ? { ...file, status: "R", oldPath: originals.get(key), added: [] } : file;
  });
}

/**
 * Files naming each word, with `git grep -l -w -F --untracked` semantics. `prefetchWords` lists the candidate files of
 * every pure word-character word with one grep and reads each candidate's word tokens once: such a word is a whole-word
 * match exactly where it is a maximal ASCII word token, as `git grep -w` defines one. A word with another character
 * (`$`) can straddle tokens and is searched alone. One `-o -w` grep per batch took 8.5 s where this takes 0.5 s.
 */
export function wordSearch(worktree, run = (args) => git(worktree, args)) {
  const hits = new Map();
  const tokens = memoize((file) => {
    try { return new Set(readFileSync(path.join(worktree, file), "latin1").match(WORD_TOKENS) ?? []); }
    catch { return new Set(); }
  });
  const prefetchWords = (words) => {
    const missing = [...new Set(words)].filter((word) => !hits.has(word));
    for (const word of missing.filter((entry) => !WORD_TOKEN.test(entry))) {
      hits.set(word, lines(() => run(["grep", "-l", "-w", "-F", "--untracked", "-e", word])));
    }
    const batched = missing.filter((word) => WORD_TOKEN.test(word));
    for (let start = 0; start < batched.length; start += WORD_BATCH) {
      const chunk = batched.slice(start, start + WORD_BATCH);
      const candidates = lines(() => run(["grep", "-l", "-z", "-F", "--untracked", ...chunk.flatMap((word) => ["-e", word])]))
        .join("\n").split("\0").filter(Boolean);
      for (const word of chunk) hits.set(word, candidates.filter((file) => tokens(file).has(word)));
    }
  };
  return {
    prefetchWords,
    wordFiles: (word) => {
      prefetchWords([word]);
      return hits.get(word);
    },
  };
}

function memoize(read) {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) {
      cache.set(key, read(key));
    }
    return cache.get(key);
  };
}

/** Non-empty output lines of a git read; a command that matches nothing (grep's exit 1) or a missing path is empty. */
export function lines(read) {
  try {
    return read().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Reads many base blobs through one `git cat-file --batch`. */
function readBlobs(worktree, base, files) {
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: worktree, input: files.map((file) => `${base}:${file}`).join("\n") + "\n", maxBuffer: 512 * 1024 * 1024,
  });
  const texts = new Map();
  let offset = 0;
  for (const file of files) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString();
    const size = Number(header.split(" ")[2]);
    offset = end + 1;
    if (header.endsWith("missing")) {
      continue;
    }
    texts.set(file, output.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return texts;
}

/** Every tracked file importing each of `files` by its directory and stem, or by `./stem` beside it. */
function importersOf(worktree, files) {
  const targets = files.map((file) => {
    const stem = path.basename(file).replace(/\.[jt]sx?$/, "");
    const directory = path.dirname(file);
    return { file, directory, elsewhere: `${path.basename(directory)}/${stem}`, sibling: `./${stem}`, stem };
  });
  const hits = targets.length === 0 ? [] : lines(() => git(worktree, ["grep", "-F", ...targets.flatMap((target) => ["-e", target.elsewhere, "-e", target.sibling]), "--", "*.ts", "*.tsx", "*.js", "*.jsx"]));
  const found = new Map();
  for (const target of targets) {
    const elsewhere = new RegExp(`from ["'][^"']*/${escapeRegExp(target.elsewhere)}(?:\\.js)?["']`);
    const sibling = new RegExp(`from ["']\\./${escapeRegExp(target.stem)}(?:\\.js)?["']`);
    const importing = new Set();
    for (const hit of hits) {
      const at = hit.indexOf(":");
      const hitFile = hit.slice(0, at);
      const text = hit.slice(at + 1);
      if (hitFile !== target.file && (elsewhere.test(text) || (path.dirname(hitFile) === target.directory && sibling.test(text)))) {
        importing.add(hitFile);
      }
    }
    found.set(target.file, importing);
  }
  return found;
}
