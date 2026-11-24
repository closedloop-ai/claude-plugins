import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { rebuildStatics, writeSubsetConfig } from "./frozen-render.mjs";
import { bindProviderInProcess, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

bindProviderInProcess(after);

const FIRST = "apps/storybook/stories/first.stories.tsx";
const SHARED = "packages/app/shared/components/second.stories.tsx";

/** A worktree whose `.storybook` has a main, a preview and preview HTML, and which holds `stories`. */
function worktree(root, name, stories) {
  const dir = path.join(root, name);
  const config = path.join(dir, "apps", "storybook", ".storybook");
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, "main.ts"), "export default { stories: ['../stories/**/*.stories.tsx'], staticDirs: ['../public'] };\n");
  writeFileSync(path.join(config, "preview.tsx"), "export default {};\n");
  writeFileSync(path.join(config, "preview-head.html"), "<style>body { margin: 0 }</style>\n");
  for (const story of stories) {
    mkdirSync(path.dirname(path.join(dir, story)), { recursive: true });
    writeFileSync(path.join(dir, story), "export default { title: 'X' };\n");
  }
  return dir;
}

const INDEXED = { [FIRST]: "./stories/first.stories.tsx", [SHARED]: "../../packages/app/shared/components/second.stories.tsx" };

/** A Storybook index.json holding one story entry per file, by Storybook's importPath (relative to apps/storybook). */
function writeIndex(staging, files) {
  writeFileSync(path.join(staging, "index.json"), JSON.stringify({ v: 5, entries: Object.fromEntries(files.map((file, n) => [`s--${n}`, { id: `s--${n}`, type: "story", importPath: INDEXED[file] }])) }));
}

const subsetDirs = (dir) => readdirSync(path.join(dir, "apps", "storybook")).filter((name) => name.startsWith(".storybook-frozen-"));

test("a subset config reuses .storybook's main and preview and collects only the named story files (ISS-14395)", (t) => {
  const { root, cleanup } = makeHome("vibe-frozen-subset-");
  t.after(cleanup);
  const dir = worktree(root, "wt", [FIRST, SHARED]);
  const config = writeSubsetConfig(dir, [FIRST, SHARED], "token");
  assert.equal(config, path.join(dir, "apps", "storybook", ".storybook-frozen-token"));
  assert.equal(readFileSync(path.join(config, "main.ts"), "utf8"),
    'import config from "../.storybook/main";\n\nexport default { ...config, stories: ["../stories/first.stories.tsx","../../../packages/app/shared/components/second.stories.tsx"] };\n');
  assert.equal(readFileSync(path.join(config, "preview.tsx"), "utf8"), 'export * from "../.storybook/preview";\nexport { default } from "../.storybook/preview";\n');
  assert.equal(readFileSync(path.join(config, "preview-head.html"), "utf8"), "<style>body { margin: 0 }</style>\n");
  assert.equal(existsSync(path.join(config, "preview-body.html")), false);
  const bare = path.join(root, "bare");
  mkdirSync(path.join(bare, "apps", "storybook", ".storybook"), { recursive: true });
  assert.throws(() => writeSubsetConfig(bare, [FIRST], "t"), /has no main file/);
});

test("both checkouts build at once in one heavy slot, each from its own subset config, removed afterwards (ISS-14395)", (t) => {
  const { root, cleanup } = makeHome("vibe-frozen-subset-build-");
  t.after(cleanup);
  // The base lacks the shared story file, so its subset holds only the first.
  const base = worktree(root, "base", [FIRST]);
  const head = worktree(root, "head", [FIRST, SHARED]);
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const slot = args.findIndex((arg) => path.basename(arg) === "slot-lock.sh");
    assert.deepEqual(args.slice(slot + 1, slot + 7), ["--slots", "1", "--wait-seconds", "1800", "heavy", "frozen-render base head"]);
    const script = args.indexOf("-c");
    assert.ok(script > slot && args[script - 1] === "bash", "one bash runs both builds inside the one slot");
    // After -c come the script, its $0, node and run-bounded, then one `<cwd> <count> <args...>` group per checkout.
    assert.equal(path.basename(args[script + 4]), "run-bounded.mjs");
    let rest = args.slice(script + 5);
    for (const dir of [base, head]) {
      const [cwd, count, ...more] = rest;
      const buildArgs = more.slice(0, Number(count));
      rest = more.slice(Number(count));
      assert.equal(cwd, path.join(dir, "apps", "storybook"));
      const configDir = buildArgs[buildArgs.indexOf("--config-dir") + 1];
      assert.ok(configDir.startsWith(path.join(dir, "apps", "storybook", ".storybook-frozen-")));
      const main = readFileSync(path.join(configDir, "main.ts"), "utf8");
      assert.equal(main.includes("second.stories.tsx"), dir === head, "a story file a checkout lacks is left out of its subset");
      const staging = buildArgs.at(-1);
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, "index.html"), `built ${path.basename(dir)}`);
      writeIndex(staging, dir === head ? [FIRST, SHARED] : [FIRST]);
    }
    assert.deepEqual(rest, []);
    return { status: 0, stdout: "", stderr: "" };
  };
  rebuildStatics([base, head], { run, env: {}, storyFiles: [FIRST, SHARED] });
  assert.equal(calls.length, 1);
  for (const dir of [base, head]) {
    assert.equal(readFileSync(path.join(dir, "apps", "storybook", "storybook-static", "index.html"), "utf8"), `built ${path.basename(dir)}`);
    assert.deepEqual(subsetDirs(dir), [], "the subset config is removed after the build");
  }
  const failing = () => ({ status: 1, stdout: "", stderr: "build failed" });
  assert.throws(() => rebuildStatics([base, head], { run: failing, env: {}, storyFiles: [FIRST] }), /Storybook static build failed/);
  for (const dir of [base, head]) {
    assert.deepEqual(subsetDirs(dir), [], "and after a failed one");
    assert.deepEqual(readdirSync(path.join(dir, "apps", "storybook")).filter((name) => name.includes(".vibe-build-")), []);
    assert.equal(readFileSync(path.join(dir, "apps", "storybook", "storybook-static", "index.html"), "utf8"), `built ${path.basename(dir)}`);
  }
});

test("the parallel builds really run side by side, may print megabytes, and one failed build fails the step", (t) => {
  const { root, cleanup } = makeHome("vibe-frozen-subset-parallel-");
  t.after(cleanup);
  const base = worktree(root, "base", [FIRST]);
  const head = worktree(root, "head", [FIRST]);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  // Each fake build waits until both have started, so builds run one after another would time out.
  const marks = path.join(root, "marks");
  mkdirSync(marks);
  const fakePnpm = path.join(bin, "pnpm");
  writeFileSync(fakePnpm, `#!/bin/sh
out=
for arg in "$@"; do out="$arg"; done
touch "${marks}/$(basename "$(dirname "$(dirname "$PWD")")")"
# A real Storybook build prints well over spawnSync's default 1 MB buffer.
head -c 2000000 /dev/zero | tr '\\0' x
for i in $(seq 1 100); do [ "$(ls "${marks}" | wc -l)" -ge 2 ] && break; sleep 0.05; done
[ "$(ls "${marks}" | wc -l)" -ge 2 ] || { echo builds-not-parallel >&2; exit 44; }
[ -f "$FAIL_IN/$(basename "$(dirname "$(dirname "$PWD")")")" ] && exit 45
mkdir -p "$out"
printf fresh >"$out/index.html"
printf '{"v":5,"entries":{"s--0":{"type":"story","importPath":"./stories/first.stories.tsx"}}}' >"$out/index.json"
`);
  chmodSync(fakePnpm, 0o700);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLOT_LOCK_DIR: path.join(root, "locks"), SLOT_LOCK_POLL_SECONDS: "0.01", FAIL_IN: path.join(root, "fail") };
  rebuildStatics([base, head], { env, storyFiles: [FIRST] });
  for (const dir of [base, head]) assert.equal(readFileSync(path.join(dir, "apps", "storybook", "storybook-static", "index.html"), "utf8"), "fresh");
  mkdirSync(path.join(root, "fail"));
  writeFileSync(path.join(root, "fail", "head"), "");
  for (const name of readdirSync(marks)) writeFileSync(path.join(marks, name), "");
  assert.throws(() => rebuildStatics([base, head], { env, storyFiles: [FIRST] }), /Storybook static build failed/);
  assert.equal(readFileSync(path.join(base, "apps", "storybook", "storybook-static", "index.html"), "utf8"), "fresh", "no output is replaced when either build fails");
});

test("a subset build whose index lacks a story file it was given fails, leaving both prior outputs in place (ISS-14395)", (t) => {
  const { root, cleanup } = makeHome("vibe-frozen-subset-index-");
  t.after(cleanup);
  const base = worktree(root, "base", [FIRST, SHARED]);
  const head = worktree(root, "head", [FIRST, SHARED]);
  for (const dir of [base, head]) {
    mkdirSync(path.join(dir, "apps", "storybook", "storybook-static"), { recursive: true });
    writeFileSync(path.join(dir, "apps", "storybook", "storybook-static", "index.html"), "prior");
  }
  const run = (_command, args) => {
    let rest = args.slice(args.indexOf("-c") + 5);
    for (const dir of [base, head]) {
      const [, count, ...more] = rest;
      const staging = more.slice(0, Number(count)).at(-1);
      rest = more.slice(Number(count));
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, "index.html"), "new");
      // The head's build matched only the first story file, as a glob that cannot match the other would.
      writeIndex(staging, dir === head ? [FIRST] : [FIRST, SHARED]);
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.throws(() => rebuildStatics([base, head], { run, env: {}, storyFiles: [FIRST, SHARED] }),
    new RegExp(`did not index ${SHARED.replaceAll(".", "\\.")} \\(head\\)`));
  for (const dir of [base, head]) {
    assert.equal(readFileSync(path.join(dir, "apps", "storybook", "storybook-static", "index.html"), "utf8"), "prior");
    assert.deepEqual(readdirSync(path.join(dir, "apps", "storybook")).filter((name) => name.includes(".vibe-build-") || name.startsWith(".storybook-frozen-")), []);
  }
});
