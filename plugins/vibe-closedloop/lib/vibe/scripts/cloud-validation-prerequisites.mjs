import { bootstrapCommand, optInPath, recipeProvider } from "./cloud-validation-recipes.mjs";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalCloudArgv, cloudTypecheckArgv, literalArgv } from "./cloud-validation-host.mjs";
import { workspacePackages } from "./workflow-lane-definitions.mjs";

const PACKAGE_NAME = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;
const WORKSPACE_PATH = /^(?:[A-Za-z0-9_.-]+\/)*package\.json$/;
const EMITTED_ENTRY = /^(?:\.\/)?(?:dist|build|out|lib)\//;
const TURBO_CONFIG = "turbo.json";
const JSONC_TOKENS = /"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;

function readOptional(read, file) {
  try { return read(file); } catch { return null; }
}

function manifest(read, file) {
  const text = readOptional(read, file);
  if (text === null) return null;
  // Turbo's committed config permits comments. Preserve literals such as schema URLs and output globs.
  const json = file === TURBO_CONFIG ? text.replace(JSONC_TOKENS, (token) => token.startsWith('"') ? token : " ") : text;
  return JSON.parse(json);
}

function workspaceMatcher(pattern) {
  const exclude = pattern.startsWith("!");
  const glob = pattern.replace(/^!/, "").split(/(\*\*|\*)/).map((part) =>
    part === "**" ? ".*" : part === "*" ? "[^/]+" : part.replace(/[.+?^$(){}|[\]\\]/g, "\\$&")).join("");
  return { exclude, re: new RegExp(`^${glob}$`) };
}

function hasOutputReference(value) {
  if (typeof value === "string") return EMITTED_ENTRY.test(value);
  if (Array.isArray(value)) return value.some(hasOutputReference);
  return Boolean(value && typeof value === "object" && Object.values(value).some(hasOutputReference));
}

function buildIsRequired(pkg, turbo) {
  return typeof pkg.scripts?.build === "string" && (["main", "types", "module", "exports", "bin"].some((field) => hasOutputReference(pkg[field]))
    || (turbo?.tasks?.[`${pkg.name}#build`]?.outputs ?? []).length > 0);
}

function dependencies(pkg) {
  return Object.entries({ ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.dependencies, ...pkg.devDependencies })
    .flatMap(([name, target]) => {
      if (typeof target !== "string" || !target.startsWith("workspace:")) return [];
      const alias = /^workspace:((?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)@/i.exec(target)?.[1];
      return [alias ?? name];
    });
}

function lanePackageNames(command, packages, read) {
  const tokens = canonicalCloudArgv(cloudTypecheckArgv(literalArgv(command),read));
  const selected = new Set();
  const take = (token) => {
    if (!token) return;
    if (packages.has(token)) selected.add(token);
    const relative = token.replace(/^\.\//, "");
    const owner = [...packages.values()].filter(({ directory }) => directory && (relative === directory || relative.startsWith(directory + "/")))
      .sort((a, b) => b.directory.length - a.directory.length)[0];
    if (owner) selected.add(owner.name);
  };
  for (const [index, token] of tokens.entries()) {
    if (["--filter", "-F", "--dir", "-C"].includes(token)) take(tokens[index + 1]);
    else if (token.startsWith("--filter=") || token.startsWith("--dir=")) take(token.split("=")[1]);
    else if (!token.startsWith("-") && token.includes("/") && !token.startsWith("/") && !token.includes("..")) take(token);
  }
  return selected;
}

function namedBuild(pkg) {
  const hash = createHash("sha256").update(pkg.name).digest("hex").slice(0, 12);
  return { name: `setup:workspace:${hash}`, command: `pnpm --filter ${pkg.name} build`, prerequisite: true };
}

/** Resolve committed bootstrap and topologically ordered workspace builds only from the lane's exact checkout. */
export function validationPrerequisites(lanes, { read, files }) {
  if (lanes.length === 0) return [];
  const workspace = readOptional(read, "pnpm-workspace.yaml");
  if (!workspace) return [];
  const patterns = (workspacePackages(workspace) ?? []).map(workspaceMatcher);
  const packages = new Map();
  for (const file of files().filter((entry) => WORKSPACE_PATH.test(entry) && entry !== "package.json")) {
    const directory = path.posix.dirname(file);
    if (!patterns.some(({ exclude, re }) => !exclude && re.test(directory)) || patterns.some(({ exclude, re }) => exclude && re.test(directory))) continue;
    const parsed = manifest(read, file);
    if (!PACKAGE_NAME.test(parsed?.name ?? "") || packages.has(parsed.name)) continue;
    packages.set(parsed.name, { ...parsed, directory });
  }
  const turbo = manifest(read, TURBO_CONFIG);
  const optedIn = optInPath && manifest(read, optInPath)?.provider === recipeProvider;
  const setup = optedIn && bootstrapCommand && readOptional(read, bootstrapCommand.replace(/^\.\//, "")) !== null ? [{ name: "setup:repo-bootstrap", command: bootstrapCommand, prerequisite: true }] : [];
  if (setup.length === 0 && readOptional(read, "pnpm-lock.yaml") !== null) setup.push({ name: "setup:lockfile", command: "pnpm install --frozen-lockfile", prerequisite: true });
  const targets = new Set(lanes.flatMap(({ command }) => [...lanePackageNames(command, packages, read)]));
  const visiting = new Set();
  const done = new Set();
  const visit = (name, build) => {
    const pkg = packages.get(name);
    if (!pkg || done.has(name)) return;
    if (visiting.has(name)) throw new Error(`cloud workspace dependency cycle at ${name}`);
    visiting.add(name);
    for (const dep of dependencies(pkg)) visit(dep, true);
    visiting.delete(name);
    if (build && buildIsRequired(pkg, turbo)) {
      setup.push(namedBuild(pkg));
      done.add(name);
    }
  };
  for (const target of targets) visit(target, false);
  return setup;
}

/** Reject a claimed requested-lane run after an earlier prerequisite failed or did not run. */
export function validatePrerequisiteOutcomes(specs, outcomes) {
  let failed;
  for (const [index, spec] of specs.entries()) {
    const outcome = outcomes[index];
    if (failed && Number.isInteger(outcome.exitCode)) {
      throw new Error(`cloud validation ran ${spec.name} after prerequisite ${failed} failed; result refused`);
    }
    if (spec.prerequisite && outcome.exitCode !== 0 && !failed) failed = spec.name;
  }
}
