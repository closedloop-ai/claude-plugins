import { accessSync, chmodSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ClaudeEvalIsolation {
  executable: string;
  binDir: string;
  mcpConfigFile: string;
}

export interface EvalMcpGrant {
  name: string;
  service: "graph" | "closedloop";
  access: "read" | "write";
  operation: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * Build a run-owned Claude entrypoint with an exact MCP allowlist.
 *
 * The wrapper stays first on PATH so Claude processes started by the released
 * production launcher inherit the same strict configuration. Authentication
 * remains owned by the real Claude executable, while user and project MCP
 * registrations are excluded by `--setting-sources ''` and
 * `--strict-mcp-config`.
 */
export function createClaudeEvalIsolation(root: string, claudeExecutable: string,
  grants: readonly EvalMcpGrant[], searchPath = process.env.PATH ?? ""): ClaudeEvalIsolation {
  if (!root || !claudeExecutable || new Set(grants.map((item) => item.name)).size !== grants.length) {
    throw new Error("eval-claude-isolation-input-invalid");
  }
  const operations = grants.map((grant) => {
    if (grant.service !== "graph" || grant.access !== "read" ||
        grant.name !== `mcp__closedloop-graph__${grant.operation}` ||
        !/^[a-z][a-z0-9_]*$/.test(grant.operation)) {
      throw new Error("eval-claude-isolation-grant-invalid");
    }
    return grant.operation;
  }).sort();
  const isolationRoot = join(root, "claude-isolation");
  const binDir = join(isolationRoot, "bin");
  const mcpConfigFile = join(isolationRoot, "mcp.json");
  const executable = join(binDir, "claude");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const mcpServers = operations.length === 0 ? {} : {
    "closedloop-graph": {
      type: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types",
        fileURLToPath(new URL("./eval-mcp-stub.ts", import.meta.url)),
        "--operations", operations.join(",")],
    },
  };
  writeFileSync(mcpConfigFile, `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  const python = findPython3(searchPath, binDir);
  const script = `#!/bin/sh\n${python ? pillowInstallStep(python, binDir) : ""}` +
    `PATH=${shellQuote(binDir)}:\"$PATH\"\nexport PATH\n` +
    `exec ${shellQuote(claudeExecutable)} --setting-sources '' --mcp-config ` +
    `${shellQuote(mcpConfigFile)} --strict-mcp-config \"$@\"\n`;
  if (python) {
    writeFileSync(pillowRequirementsFile(binDir), pillowRequirements(), { flag: "wx", mode: 0o600 });
    writeFileSync(join(binDir, "python3"), `#!/bin/sh\nPYTHONPATH=${shellQuote(pythonLibDir(binDir))}` +
      `\${PYTHONPATH:+:\"$PYTHONPATH\"}\nexport PYTHONPATH\nexec ${shellQuote(python)} \"$@\"\n`,
    { flag: "wx", mode: 0o700 });
    chmodSync(join(binDir, "python3"), 0o700);
  }
  writeFileSync(executable, script, { flag: "wx", mode: 0o700 });
  chmodSync(executable, 0o700);
  if (dirname(executable) !== binDir) throw new Error("eval-claude-isolation-path-invalid");
  return { executable, binDir, mcpConfigFile };
}

/**
 * Pillow for the eval fixture's tools/screenshot.py. The case sandbox blocks
 * the network and every read under /Users and /private/tmp, so the wrapper
 * installs it outside the sandbox into the bin directory the sandbox may read.
 * Pinned to 11.3.0: the nightly's python3 is 3.9 and Pillow 12 needs 3.10 or later (ISS-14162).
 */
const CLAUDE_EVAL_PILLOW = "Pillow==11.3.0";

/**
 * sha256 of every Pillow 11.3.0 CPython macOS wheel (cp39 to cp314, arm64 and
 * x86_64), from https://pypi.org/pypi/Pillow/11.3.0/json. pip installs with
 * --require-hashes, so a file whose digest is not listed here is refused.
 */
const CLAUDE_EVAL_PILLOW_SHA256: readonly string[] = [
  "1b9c17fd4ace828b3003dfd1e30bff24863e0eb59b535e8f80194d9cc7ecf860", // cp310-cp310-macosx_10_10_x86_64
  "65dc69160114cdd0ca0f35cb434633c75e8e7fad4cf855177a05bf38678f73ad", // cp310-cp310-macosx_11_0_arm64
  "1cd110edf822773368b396281a2293aeb91c90a2db00d78ea43e7e861631b722", // cp311-cp311-macosx_10_10_x86_64
  "9c412fddd1b77a75aa904615ebaa6001f169b26fd467b4be93aded278266b288", // cp311-cp311-macosx_11_0_arm64
  "fdae223722da47b024b867c1ea0be64e0df702c5e0a60e27daad39bf960dd1e4", // cp312-cp312-macosx_10_13_x86_64
  "921bd305b10e82b4d1f5e802b6850677f965d8394203d182f078873851dada69", // cp312-cp312-macosx_11_0_arm64
  "ec1ee50470b0d050984394423d96325b744d55c701a439d2bd66089bff963d3c", // cp313-cp313-macosx_10_13_x86_64
  "7db51d222548ccfd274e4572fdbf3e810a5e66b00608862f947b163e613b67dd", // cp313-cp313-macosx_11_0_arm64
  "4c834a3921375c48ee6b9624061076bc0a32a60b5532b322cc0ea64e639dd50e", // cp313-cp313t-macosx_10_13_x86_64
  "5e05688ccef30ea69b9317a9ead994b93975104a677a36a8ed8106be9260aa6d", // cp313-cp313t-macosx_11_0_arm64
  "d9da3df5f9ea2a89b81bb6087177fb1f4d1c7146d583a3fe5c672c0d94e55e12", // cp314-cp314-macosx_10_13_x86_64
  "0b275ff9b04df7b640c59ec5a3cb113eefd3795a8df80bac69646ef699c6981a", // cp314-cp314-macosx_11_0_arm64
  "59a03cdf019efbfeeed910bf79c7c93255c3d54bc45898ac2a4140071b02b4ae", // cp314-cp314t-macosx_10_13_x86_64
  "f8a5827f84d973d8636e9dc5764af4f0cf2318d26744b3d902931701b0d46653", // cp314-cp314t-macosx_11_0_arm64
  "48d254f8a4c776de343051023eb61ffe818299eeac478da55227d96e241de53f", // cp39-cp39-macosx_10_10_x86_64
  "7aee118e30a4cf54fdd873bd3a29de51e29105ab11f9aad8c32123f58c8f8081", // cp39-cp39-macosx_11_0_arm64
];
export const CLAUDE_EVAL_PILLOW_FAILED = "eval-claude-pillow-install-failed";

function pythonLibDir(binDir: string): string {
  return join(binDir, ".python-packages");
}

/** The first python3 on PATH, which is the one the sandboxed model would run. */
function findPython3(searchPath: string, binDir: string): string | null {
  for (const dir of searchPath.split(":")) {
    if (!isAbsolute(dir) || dir === binDir) continue;
    const candidate = join(dir, "python3");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not on this PATH entry */ }
  }
  return null;
}

// Runs once per isolation root, before PATH reaches the shim. The marker stops
// a nested launch inside the sandbox from retrying. A failed install leaves the
// visual cases where they were and must not block the other cases.
function pillowInstallStep(python: string, binDir: string): string {
  const lib = shellQuote(pythonLibDir(binDir));
  const marker = shellQuote(join(pythonLibDir(binDir), ".attempted"));
  const requirements = shellQuote(pillowRequirementsFile(binDir));
  return `if [ ! -e ${marker} ]; then\n` +
    `  mkdir -p ${lib} && : > ${marker} &&\n` +
    `  ${shellQuote(python)} -m pip install --disable-pip-version-check --no-input --quiet ` +
    `--only-binary=:all: --no-deps --require-hashes --target ${lib} -r ${requirements} >&2 ||\n` +
    `  echo ${shellQuote(CLAUDE_EVAL_PILLOW_FAILED)} >&2\nfi\n`;
}

function pillowRequirementsFile(binDir: string): string {
  return join(binDir, "pillow-requirements.txt");
}

/** The hash-locked requirements file pip reads, written next to the python3 shim. */
function pillowRequirements(): string {
  return `${[CLAUDE_EVAL_PILLOW, ...CLAUDE_EVAL_PILLOW_SHA256.map((hash) => `--hash=sha256:${hash}`)]
    .join(" \\\n    ")}\n`;
}
