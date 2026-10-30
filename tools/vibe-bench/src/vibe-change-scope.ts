import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export type VibePathKind = "behavior" | "non-behavior" | "unrelated";

export interface VibePathDecision {
  path: string;
  kind: VibePathKind;
  reason: string;
}

export interface VibeChangeScope {
  decisions: VibePathDecision[];
  behaviorFiles: string[];
  nonBehaviorFiles: string[];
}

const PLUGIN_PREFIX = "plugins/vibe/";
const BEHAVIOR_PATHS = [
  /^plugins\/vibe\/(?:\.claude-plugin|\.codex-plugin)(?:\/|$)/,
  /^plugins\/vibe\/(?:plugin\.json|mcp\.json|\.mcp\.json|\.lsp\.json)$/,
  /^plugins\/vibe\/(?:skills|agents|commands|hooks|shared|scripts|monitors|output-styles|themes|workflows)(?:\/|$)/,
];
const BENCHMARK_INFRASTRUCTURE = [
  /^tools\/vibe-bench(?:\/|$)/,
  /^tools\/vibe-workers(?:\/|$)/,
  /^\.agents\/skills\/vibe-bench(?:\/|$)/,
  /^\.claude\/skills\/vibe-bench(?:\/|$)/,
  /^\.github\/workflows\/vibe-benchmark-gate\.yml$/,
  /^\.github\/pull_request_template\.md$/,
];
const DOCUMENTATION_ONLY = [
  /^plugins\/vibe\/(?:README|CHANGELOG)(?:\.[^/]+)?$/i,
  /^plugins\/vibe\/docs(?:\/|$)/,
];
const TEST_ONLY = [
  /^plugins\/vibe\/evals(?:\/|$)/,
  /(?:^|\/)(?:__tests__|tests?)(?:\/|$)/,
  /(?:^|\/)(?:test-fixtures|fixture-helper)\.[^/]+$/,
  /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/,
  /(?:^|\/)test_[^/]+\.py$/,
];

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return filesBelow(path);
    return entry.isFile() ? [path] : [];
  });
}

function slash(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Detect documentation outside a runtime component that is nevertheless read
 * by a loaded skill, agent, manifest, or hook. Runtime documentation is part
 * of behavior even when its directory name would otherwise be informational.
 */
function referencedByRuntime(vibeDir: string, changedPath: string): boolean {
  const target = join(dirname(dirname(vibeDir)), changedPath);
  if (!existsSync(target)) return false;
  const roots = ["skills", "agents", "hooks", ".claude-plugin", ".codex-plugin"]
    .flatMap((name) => filesBelow(join(vibeDir, name)));
  return roots.filter((source) => !TEST_ONLY.some((pattern) => pattern.test(
    `${PLUGIN_PREFIX}${slash(relative(vibeDir, source))}`)))
    .some((source) => {
      let text: string;
      try { text = readFileSync(source, "utf8"); } catch { return false; }
      const fromSource = slash(relative(dirname(source), target));
      const fromPlugin = slash(relative(vibeDir, target));
      const candidates = [fromSource, fromSource.startsWith(".") ? fromSource : `./${fromSource}`];
      if (fromPlugin.includes("/")) candidates.push(fromPlugin);
      return candidates
        .some((needle) => needle.length > 0 && text.includes(needle));
    });
}

/**
 * Classify one changed path using documented runtime load points. Unknown
 * paths inside the vibe plugin are behavior-affecting by default so a new
 * component type cannot silently evade the gate.
 */
export function classifyVibePath(path: string, vibeDir: string): VibePathDecision {
  if (BENCHMARK_INFRASTRUCTURE.some((pattern) => pattern.test(path))) {
    return { path, kind: "non-behavior", reason: "benchmark-infrastructure" };
  }
  if (!path.startsWith(PLUGIN_PREFIX) && path !== "plugins/vibe") {
    return { path, kind: "unrelated", reason: "outside-vibe-plugin" };
  }
  if (TEST_ONLY.some((pattern) => pattern.test(path))) {
    return { path, kind: "non-behavior", reason: "test-only" };
  }
  if (DOCUMENTATION_ONLY.some((pattern) => pattern.test(path))) {
    return referencedByRuntime(vibeDir, path)
      ? { path, kind: "behavior", reason: "runtime-referenced-documentation" }
      : { path, kind: "non-behavior", reason: "unreferenced-documentation" };
  }
  if (BEHAVIOR_PATHS.some((pattern) => pattern.test(path))) {
    return { path, kind: "behavior", reason: "runtime-component" };
  }
  return { path, kind: "behavior", reason: "unknown-plugin-path-fail-closed" };
}

/** Classify a complete diff once for nightly change detection and local audits. */
export function classifyVibeChangeScope(changedFiles: string[], vibeDir: string): VibeChangeScope {
  const decisions = [...new Set(changedFiles)].sort().map((path) => classifyVibePath(path, vibeDir));
  return {
    decisions,
    behaviorFiles: decisions.filter((item) => item.kind === "behavior").map((item) => item.path),
    nonBehaviorFiles: decisions.filter((item) => item.kind === "non-behavior").map((item) => item.path),
  };
}

const VERSIONED_MANIFESTS = new Set([
  "plugins/vibe/.claude-plugin/plugin.json",
  "plugins/vibe/.codex-plugin/plugin.json",
]);

function withoutVersion(raw: string): unknown {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("vibe-manifest-invalid");
  }
  const { version: _version, ...rest } = parsed;
  return rest;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function gitFile(repo: string, ref: string, path: string): string {
  return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { encoding: "utf8" });
}

function referencedInGitTree(repo: string, ref: string, changedPath: string): boolean {
  try { gitFile(repo, ref, changedPath); } catch { return false; }
  const roots = ["skills", "agents", "hooks", ".claude-plugin", ".codex-plugin"]
    .map((name) => `${PLUGIN_PREFIX}${name}`);
  let sources: string[];
  try {
    sources = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", ref, "--", ...roots],
      { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch { return false; }
  return sources.filter((source) => !TEST_ONLY.some((pattern) => pattern.test(source)))
    .some((source) => {
      let text: string;
      try { text = gitFile(repo, ref, source); } catch { return false; }
      const fromSource = slash(relative(dirname(source), changedPath));
      const fromPlugin = slash(relative("plugins/vibe", changedPath));
      const candidates = [fromSource, fromSource.startsWith(".") ? fromSource : `./${fromSource}`];
      if (fromPlugin.includes("/")) candidates.push(fromPlugin);
      return candidates.some((needle) => needle.length > 0 && text.includes(needle));
    });
}

function reclassifyTreeReferencedDocs(scope: VibeChangeScope, repo: string,
  refs: string[]): VibeChangeScope {
  const decisions = scope.decisions.map((decision): VibePathDecision => {
    if (decision.reason !== "unreferenced-documentation") return decision;
    return refs.some((ref) => referencedInGitTree(repo, ref, decision.path))
      ? { ...decision, kind: "behavior", reason: "runtime-referenced-documentation" }
      : decision;
  });
  return {
    decisions,
    behaviorFiles: decisions.filter((item) => item.kind === "behavior").map((item) => item.path),
    nonBehaviorFiles: decisions.filter((item) => item.kind === "non-behavior").map((item) => item.path),
  };
}

function reclassifyVersionOnly(scope: VibeChangeScope, repo: string, baseRef: string,
  headRef: string | null): VibeChangeScope {
  const decisions = scope.decisions.map((decision): VibePathDecision => {
    if (decision.kind !== "behavior" || !VERSIONED_MANIFESTS.has(decision.path)) return decision;
    try {
      const before = withoutVersion(gitFile(repo, baseRef, decision.path));
      const after = withoutVersion(headRef === null
        ? readFileSync(join(repo, decision.path), "utf8")
        : gitFile(repo, headRef, decision.path));
      return stable(before) === stable(after)
        ? { ...decision, kind: "non-behavior", reason: "version-only-manifest" }
        : decision;
    } catch { return decision; }
  });
  return {
    decisions,
    behaviorFiles: decisions.filter((item) => item.kind === "behavior").map((item) => item.path),
    nonBehaviorFiles: decisions.filter((item) => item.kind === "non-behavior").map((item) => item.path),
  };
}

/** Classify an exact committed range, including version-only manifest bumps. */
export function classifyVibeChangeScopeBetween(repo: string, baseRef: string,
  headRef: string): VibeChangeScope {
  const changed = execFileSync("git", ["-C", repo, "diff", "--name-only", baseRef, headRef],
    { encoding: "utf8" }).split("\n").filter(Boolean);
  const scope = reclassifyTreeReferencedDocs(
    classifyVibeChangeScope(changed, join(repo, "plugins/vibe")), repo, [baseRef, headRef]);
  return reclassifyVersionOnly(scope, repo, baseRef, headRef);
}

/** Classify the current working tree against a base for local model-free audits. */
export function classifyVibeWorkingTreeScope(repo: string, baseRef: string,
  changedFiles: string[]): VibeChangeScope {
  const scope = reclassifyTreeReferencedDocs(
    classifyVibeChangeScope(changedFiles, join(repo, "plugins/vibe")), repo, [baseRef]);
  return reclassifyVersionOnly(scope, repo, baseRef, null);
}
