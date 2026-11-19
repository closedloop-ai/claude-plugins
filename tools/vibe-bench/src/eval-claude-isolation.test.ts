import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { CLAUDE_EVAL_PILLOW_FAILED, createClaudeEvalIsolation } from "./eval-claude-isolation.ts";

// A stand-in python3 at the PATH boundary: `-m pip ...` is logged and answered
// with the given exit status; any other call reports what the interpreter saw.
function fakePython(dir: string, pipLog: string, pipStatus: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "python3"), `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  printf '%s\\n' "$*" >> '${pipLog}'
  echo fake-pip-stdout
  exit ${pipStatus}
fi
echo "interpreter=$0 PYTHONPATH=$PYTHONPATH args=$*"
`, { mode: 0o700 });
}

// A stand-in claude that shows which python3 a sandboxed Bash call would get.
function fakeClaude(root: string): string {
  const path = join(root, "fake-claude");
  writeFileSync(path, `#!/bin/sh
echo "claude-args=$*"
echo "python3=$(command -v python3)"
python3 probe.py
`, { mode: 0o700 });
  return path;
}

function launch(executable: string, path: string, pythonPath?: string) {
  const env: NodeJS.ProcessEnv = { PATH: path, HOME: tmpdir() };
  if (pythonPath !== undefined) env.PYTHONPATH = pythonPath;
  return spawnSync(executable, ["--print", "hi"], { encoding: "utf8", env });
}

test("ISS-14162 wrapper installs pinned Pillow once and puts a python3 shim first on PATH", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-eval-pillow-")));
  try {
    const pipLog = join(root, "pip.log");
    const skipped = join(root, "not-executable");
    mkdirSync(skipped);
    writeFileSync(join(skipped, "python3"), "not a program\n", { mode: 0o600 });
    const pythonDir = join(root, "python-bin");
    fakePython(pythonDir, pipLog, 0);
    const path = `relative:${skipped}:${pythonDir}:/usr/bin:/bin`;
    const isolated = createClaudeEvalIsolation(join(root, "run"), fakeClaude(root), [], path);
    const lib = join(isolated.binDir, ".python-packages");

    const first = launch(isolated.executable, path, "/caller/site");
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(readFileSync(pipLog, "utf8").trim().split("\n"), [
      `-m pip install --disable-pip-version-check --no-input --quiet --only-binary=:all: ` +
      `--no-deps --require-hashes --target ${lib} -r ${join(isolated.binDir, "pillow-requirements.txt")}`]);
    const lines = first.stdout.trim().split("\n");
    assert.deepEqual(lines, [
      `claude-args=--setting-sources  --mcp-config ${isolated.mcpConfigFile} --strict-mcp-config ` +
      "--print hi",
      `python3=${join(isolated.binDir, "python3")}`,
      `interpreter=${join(pythonDir, "python3")} PYTHONPATH=${lib}:/caller/site args=probe.py`]);
    assert.match(first.stderr, /fake-pip-stdout/, "pip output must not reach Claude's stdout");
    assert.doesNotMatch(first.stderr, new RegExp(CLAUDE_EVAL_PILLOW_FAILED));

    const second = launch(isolated.executable, path);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(pipLog, "utf8").trim().split("\n").length, 1,
      "a later or nested launch must not install again");
    assert.equal(second.stdout.trim().split("\n").at(-1),
      `interpreter=${join(pythonDir, "python3")} PYTHONPATH=${lib} args=probe.py`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 a failed Pillow install is logged and still launches Claude", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-eval-pillow-fail-")));
  try {
    const pythonDir = join(root, "python-bin");
    fakePython(pythonDir, join(root, "pip.log"), 1);
    const path = `${pythonDir}:/usr/bin:/bin`;
    const isolated = createClaudeEvalIsolation(join(root, "run"), fakeClaude(root), [], path);
    const result = launch(isolated.executable, path);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^claude-args=/);
    assert.match(result.stderr, new RegExp(`^${CLAUDE_EVAL_PILLOW_FAILED}$`, "m"));
    assert.doesNotMatch(result.stdout, /fake-pip-stdout/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 with no python3 on PATH the wrapper adds no shim and no install", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-eval-pillow-none-")));
  try {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const isolated = createClaudeEvalIsolation(join(root, "run"), fakeClaude(root), [], empty);
    assert.equal(existsSync(join(isolated.binDir, "python3")), false);
    assert.doesNotMatch(readFileSync(isolated.executable, "utf8"), /pip/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Digests copied from https://pypi.org/pypi/Pillow/11.3.0/json for the nightly's
// python3 3.9 on both Mac architectures; literals, never read from the source.
const PYPI_CP39_ARM64 = "7aee118e30a4cf54fdd873bd3a29de51e29105ab11f9aad8c32123f58c8f8081";
const PYPI_CP39_X86_64 = "48d254f8a4c776de343051023eb61ffe818299eeac478da55227d96e241de53f";

test("ISS-14162 the Pillow install is hash-locked to the PyPI 11.3.0 macOS wheels", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vibe-eval-pillow-hash-")));
  try {
    const pipLog = join(root, "pip.log");
    const pythonDir = join(root, "python-bin");
    fakePython(pythonDir, pipLog, 0);
    const path = `${pythonDir}:/usr/bin:/bin`;
    const isolated = createClaudeEvalIsolation(join(root, "run"), fakeClaude(root), [], path);
    const requirementsFile = join(isolated.binDir, "pillow-requirements.txt");
    const result = launch(isolated.executable, path);
    assert.equal(result.status, 0, result.stderr);

    const pip = readFileSync(pipLog, "utf8").trim().split(" ");
    assert.ok(pip.includes("--require-hashes"), "pip must refuse a wheel whose digest is not pinned");
    assert.equal(pip[pip.indexOf("-r") + 1], requirementsFile);
    assert.ok(!pip.includes("Pillow==11.3.0"), "the unhashed requirement must not reach pip");

    const lines = readFileSync(requirementsFile, "utf8").trim().split(/\s*\\\n\s*/);
    assert.equal(lines[0], "Pillow==11.3.0");
    const hashes = lines.slice(1);
    assert.equal(hashes.length, 16, "cp39 to cp314, free-threaded included, on arm64 and x86_64");
    for (const line of hashes) assert.match(line, /^--hash=sha256:[0-9a-f]{64}$/);
    assert.ok(hashes.includes(`--hash=sha256:${PYPI_CP39_ARM64}`));
    assert.ok(hashes.includes(`--hash=sha256:${PYPI_CP39_X86_64}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("AC-016 the Claude isolation wrapper resolves its real executable with either inherited PATH", (t) => {
  const root = mkdtempSync(join(tmpdir(), "eval-claude-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realBin = join(root, "real-bin");
  mkdirSync(realBin);
  const real = join(realBin, "claude");
  writeFileSync(real, "#!/bin/sh\nprintf '%s\\n' \"${PATH%%:*}\" \"$@\"\n");
  chmodSync(real, 0o700);
  const isolated = createClaudeEvalIsolation(join(root, "run"), "claude", []);
  // A model launched by Claude inherits an already isolated PATH.
  for (const inheritedPath of [realBin, [isolated.binDir, realBin].join(delimiter)]) {
    const result = spawnSync(isolated.executable, ["--version", "two words"], {
      encoding: "utf8", timeout: 2500, env: { PATH: inheritedPath },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [isolated.binDir,
      "--setting-sources", "", "--mcp-config", isolated.mcpConfigFile, "--strict-mcp-config", "--version", "two words"]);
  }
  const missing = spawnSync(isolated.executable, ["--version"], {
    encoding: "utf8", timeout: 2500, env: { PATH: isolated.binDir },
  });
  assert.equal(missing.status, 127, missing.error?.message ?? missing.stderr);
});
