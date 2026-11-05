import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { runWhenMain } from "../../shared/cli.js";

const DEFAULT_INVENTORY = fileURLToPath(new URL("../../../handoff/scripts/handoff-inventory.mjs", import.meta.url));
const PATH_POLICY_BASENAME = "vibe-handoff-paths.json";
const PROTOTYPE_CHECKER = "apps/prototypes/scripts/check-catalog-imports.mjs";

type Phase = "build" | "pull-request";
type PathPolicy = {
  version: 1;
  allowedPrefixes: string[];
  allowedFiles: string[];
  forbiddenPrefixes: string[];
  forbiddenBasenames: string[];
  rootTests: boolean;
};
type PolicySource = { kind: string; commit: string };
type InventoryResult = {
  pathPolicyProblem?: string | null;
  pathPolicyFile?: string | null;
  pathPolicySource?: PolicySource | null;
  branch?: string;
  baseCommit?: string;
  ownedPrototype?: boolean;
  sessionSlug?: string | null;
};
type PathClassification = { disposition: "allowed" | "forbidden" | "outside"; reason: string };
type PathClassifier = (input: {
  file: { path: string; status: "A" | "M" };
  phase: Phase;
  policy: PathPolicy;
  prototype: { owned: boolean; slug?: string | null };
  portableSurfaceAllowed: boolean;
}) => PathClassification;
export type IntakeScopeInput = {
  worktree: string;
  plannedPaths: string[];
  phase: Phase;
  inventoryScript?: string;
};
export type IntakeScopeResult = {
  ok: boolean;
  worktree: string;
  pathPolicyFile: string;
  pathPolicySource: PolicySource;
  allowed: string[];
  outsideAllowed: string[];
  forbidden: string[];
  allOutsideAllowed: boolean;
  message: string;
};

/** Classify planned files through the exact repository policy validated by handoff inventory. */
export async function intakeScope(input: IntakeScopeInput): Promise<IntakeScopeResult> {
  if (!input.worktree) throw new Error("--worktree is required");
  if (!Array.isArray(input.plannedPaths) || input.plannedPaths.length === 0) throw new Error("at least one --path is required");
  const worktree = resolve(input.worktree);
  const planned = [...new Set(input.plannedPaths.map(plannedPath))].sort();
  const loaded = loadPathPolicy(worktree, input.phase, input.inventoryScript ?? DEFAULT_INVENTORY);
  const classify = await pathClassifierContract();
  const classifications = await Promise.all(planned.map(async (file) => ({ file, classification: classify({
    file: { path: file, status: plannedStatus(worktree, loaded.inventory.baseCommit as string, file) },
    phase: input.phase,
    policy: loaded.policy,
    prototype: { owned: loaded.inventory.ownedPrototype === true, slug: loaded.inventory.sessionSlug },
    portableSurfaceAllowed: await portableSurfaceEditAllowed(worktree, loaded.inventory, file),
  }) })));
  return classifyPlannedPaths({ worktree, planned, loaded, classifications });
}

/** Aggregate the canonical handoff classifier's results into the intake response. */
export function classifyPlannedPaths(input: { worktree: string; planned: string[];
  loaded: { inventory: InventoryResult; policy: PathPolicy };
  classifications: Array<{ file: string; classification: PathClassification }> }): IntakeScopeResult {
  const dispositions = new Map(input.classifications.map((entry) => [entry.file, entry.classification.disposition]));
  const forbidden = input.planned.filter((file) => dispositions.get(file) === "forbidden");
  const outsideAllowed = input.planned.filter((file) => dispositions.get(file) === "outside");
  const rejected = new Set([...forbidden, ...outsideAllowed]);
  const allowed = input.planned.filter((file) => !rejected.has(file));
  const allOutsideAllowed = allowed.length === 0;
  return {
    ok: !allOutsideAllowed,
    worktree: input.worktree,
    pathPolicyFile: input.loaded.inventory.pathPolicyFile as string,
    pathPolicySource: input.loaded.inventory.pathPolicySource as PolicySource,
    allowed,
    outsideAllowed,
    forbidden,
    allOutsideAllowed,
    message: allOutsideAllowed
      ? "Every planned file is outside the repository's allowed vibe paths. Build nothing and route this work to engineering."
      : rejected.size > 0
        ? "Build only the allowed planned files and route the listed outside or forbidden paths to engineering."
        : "Every planned file is allowed for this vibe session.",
  };
}

async function pathClassifierContract(): Promise<PathClassifier> {
  const moduleUrl = new URL("../../../handoff/scripts/path-classifier.mjs", import.meta.url).href;
  const runtime = await import(moduleUrl) as { classifyHandoffPath: PathClassifier };
  return runtime.classifyHandoffPath;
}

function plannedStatus(worktree: string, baseCommit: string, file: string): "A" | "M" {
  const result = spawnSync("git", ["-C", worktree, "cat-file", "-e", `${baseCommit}:${file}`], {
    encoding: "utf8", stdio: "ignore",
  });
  return result.status === 0 ? "M" : "A";
}

async function portableSurfaceEditAllowed(worktree: string, inventory: InventoryResult, file: string) {
  if (!inventory.ownedPrototype || file !== PROTOTYPE_CHECKER || !inventory.baseCommit) return false;
  try {
    const moduleUrl = new URL("../../../handoff/scripts/prototype-allowlist.mjs", import.meta.url).href;
    const runtime = await import(moduleUrl) as {
      isPortableSurfaceAllowlistEdit: (base: string, current: string, exists: (specifier: string) => boolean) => boolean;
    };
    const base = execFileSync("git", ["-C", worktree, "show", `${inventory.baseCommit}:${file}`], { encoding: "utf8" });
    const current = readFileSync(resolve(worktree, file), "utf8");
    return runtime.isPortableSurfaceAllowlistEdit(base, current, (specifier) =>
      [".ts", ".tsx", ".mjs"].some((extension) =>
        existsSync(resolve(worktree, "packages/app", `${specifier.slice("@repo/app/".length)}${extension}`))));
  } catch {
    return false;
  }
}

function loadPathPolicy(worktree: string, _phase: Phase, inventoryScript: string) {
  const result = spawnSync(process.execPath, [inventoryScript, "--worktree", worktree, "--phase", "build"], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  let inventory: InventoryResult;
  try { inventory = JSON.parse(result.stdout) as InventoryResult; }
  catch { throw new Error(`handoff inventory did not return JSON: ${result.stderr.trim() || `exit ${result.status}`}`); }
  if (inventory.pathPolicyProblem) throw new Error(inventory.pathPolicyProblem);
  const source = inventory.pathPolicySource;
  const file = inventory.pathPolicyFile;
  if (!source?.commit || !inventory.baseCommit || file !== PATH_POLICY_BASENAME) {
    throw new Error("handoff inventory did not return one validated root path policy and base commit");
  }
  const text = execFileSync("git", ["-C", worktree, "show", `${source.commit}:${file}`], { encoding: "utf8" });
  return { inventory, policy: JSON.parse(text) as PathPolicy };
}

function plannedPath(value: string) {
  if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value) ||
    normalize(value).split(sep).join("/") !== value || value === "." || value.endsWith("/") || /[\r\n*?\[\]]/.test(value)) {
    throw new Error(`planned path must be one literal repository-relative file: ${JSON.stringify(value)}`);
  }
  return value;
}

async function main(argv: string[]) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      worktree: { type: "string" }, path: { type: "string", multiple: true },
      phase: { type: "string", default: "build" },
    } });
    if (!values.worktree || !["build", "pull-request"].includes(values.phase)) throw new Error("--worktree and --phase build|pull-request are required");
    const result = await intakeScope({ worktree: values.worktree, plannedPaths: values.path ?? [], phase: values.phase as Phase });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 2;
  }
}

runWhenMain(import.meta.url, main);
