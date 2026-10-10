import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { MainSyncError, type MainSyncReceipt, type e2eLimitationSchema } from "./main-sync-contracts.js";
import { committedIdentity, digest, syncContext } from "./main-sync-state.js";
import { discoverCheckLanes, type CheckCommand } from "./main-sync-lanes.js";

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_CHECK_MS = 15 * 60 * 1000;
const EXECUTABLE_INPUT = /(?:\.(?:[cm]?js|tsx?|jsx|py|sh|jsonc?|ya?ml|toml|css|scss|html|sql|prisma)$|(?:^|\/)\.(?:npmrc|nvmrc)|(?:^|\/)(?:package-lock|pnpm-lock))/;
const SOURCE_PATH = /\.(?:[cm]?js|tsx?|jsx|py|sh|jsonc?|ya?ml|toml|css|scss)$/;
const PRIVATE_ARTIFACT = /\.(?:md|json|log|txt|png|webp)$/;
const BACKEND_PREFIXES = ["apps/api/", "apps/mcp/", "apps/relay/", "apps/realtime/", "packages/api/",
  "packages/database/", "apps/desktop/src/main/", "apps/desktop/src/server/", "apps/desktop/prisma/"];
const CACHE_SEGMENTS = new Set(["node_modules", ".next", ".turbo", "dist", "storybook-static", ".cache"]);
const turboTasksSchema = z.object({ tasks: z.array(z.object({ taskId: z.string(), package: z.string().optional() }).passthrough()) }).passthrough();

/** Every tracked byte/mode and nonprivate executable overlay must match the committed publication tree. */
export function committedInputs(root: string) {
  const identity = committedIdentity(root);
  if (git(root, ["write-tree"]) !== identity.treeSha) throw new MainSyncError("Committed validation inputs differ from HEAD: staged source", "NEEDS_CHANGE");
  const hash = createHash("sha256");
  const entries = git(root, ["ls-tree", "-r", "-z", "HEAD"]);
  for (const entry of entries.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, kind, object] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    const target = join(root, file);
    if (kind !== "blob" || !existsSync(target)) throw new MainSyncError(`Committed validation inputs differ from HEAD: ${file}`, "NEEDS_CHANGE");
    const stat = lstatSync(target);
    if (stat.size > MAX_FILE_BYTES) throw new MainSyncError(`Validation input exceeds the bounded file limit: ${file}`);
    const content = mode === "120000" && stat.isSymbolicLink() ? Buffer.from(readlinkSync(target)) : stat.isFile() ? readFileSync(target) : undefined;
    const actual = content && createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    const executable = Boolean(stat.mode & 0o111);
    if (!content || actual !== object || (mode !== "120000" && executable !== (mode === "100755"))) {
      throw new MainSyncError(`Committed validation inputs differ from HEAD: ${file}; preserve localFix source and use the same-writer workaround flow`, "NEEDS_CHANGE");
    }
    hash.update(`${mode}\0${object}\0${file}\0`);
  }
  for (const ignored of [false, true]) {
    const args = ["ls-files", "--others", "--exclude-standard", "-z", ...(ignored ? ["--ignored"] : [])];
    for (const file of git(root, args).split("\0").filter(Boolean)) {
      if (file.split("/").some((segment) => CACHE_SEGMENTS.has(segment))) continue;
      if (PRIVATE_ARTIFACT.test(file) && (file.startsWith(".closedloop-ai/vibe-plans/")
        || file.startsWith(".closedloop-ai/decision-tables/") || file.startsWith(".control/"))) continue;
      if (EXECUTABLE_INPUT.test(file)) throw new MainSyncError(`Committed validation inputs differ from HEAD: uncommitted executable ${file}`, "NEEDS_CHANGE");
    }
  }
  const plans = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", ".closedloop-ai/vibe-plans/"]);
  if (plans) throw new MainSyncError("Local technical plans are committed; publication is blocked");
  return { ...identity, inputSha256: hash.digest("hex") };
}

/** Existing fixed recipes are selected from actual feature scope, never caller-supplied commands or PASS bits. */
export function checkRecipe(value: ReturnType<typeof syncContext>, receipt: MainSyncReceipt) {
  const root = value.place.root;
  const files = git(root, ["diff", "--name-only", "--no-renames", receipt.mainSha, "HEAD"]).split("\n").filter(Boolean);
  const prototype = value.place.branch.startsWith("prototype/");
  const backend = files.some((file) => BACKEND_PREFIXES.some((prefix) => file.startsWith(prefix)) || /\/(?:prisma|migrations)\//.test(`/${file}`));
  const paths = files.filter((file) => SOURCE_PATH.test(file) && existsSync(join(root, file)));
  const commands: CheckCommand[] = [];
  const e2eLimitations: z.infer<typeof e2eLimitationSchema>[] = [];
  if (prototype) {
    commands.push({ argv: ["pnpm", "--filter", "prototypes", "generate:registry"] },
      { argv: ["pnpm", "--filter", "prototypes", "typecheck"] },
      { argv: ["pnpm", "--filter", "prototypes", "test"] },
      { argv: ["pnpm", "exec", "biome", "check", "apps/prototypes"] },
      { argv: ["node", ".claude/skills/prototype-approve/scripts/read-decision-log.mjs", `apps/prototypes/app/p/${value.place.session.slug}/decisions.md`] });
  } else {
    if (paths.length) commands.push({ argv: ["pnpm", "exec", "biome", "check", ...paths] });
    const lanes = discoverCheckLanes(root, receipt);
    e2eLimitations.push(...lanes.limitations);
    commands.push({ argv: ["pnpm", "check:source-gates"] }, { argv: ["pnpm", "typecheck:affected"] },
      { argv: ["pnpm", "test:affected", "--continue"] }, ...lanes.commands);
    if (backend && value.purpose === "handoff") commands.push({ argv: ["pnpm", "verify"] },
      { argv: ["pnpm", "test"] }, { argv: ["pnpm", "test:lint"] }, { argv: ["pnpm", "test:skills"] });
  }
  const filter = `...[${receipt.validationSince}]`;
  commands.push({ argv: ["pnpm", "turbo", "typecheck", `--filter=${filter}`, "--concurrency=1"] },
    { argv: ["pnpm", "turbo", "test", `--filter=${filter}`, "--continue"], timeoutMs: MAX_CHECK_MS });
  if (files.some((file) => file.startsWith("packages/app/") || file.startsWith("apps/desktop/src/renderer/"))) {
    commands.push({ argv: ["pnpm", "--filter", "desktop", "test:renderer"] });
  }
  if (files.some((file) => file.includes(".stories.") || file.startsWith("apps/storybook/") || file.startsWith("packages/design-system/"))) {
    commands.push({ argv: ["pnpm", "--filter", "storybook", "test"] }, { argv: ["pnpm", "--filter", "storybook", "validate:catalog"] });
  }
  if (value.purpose === "handoff") commands.push({ argv: ["pnpm", "vibe", "storybook-diff"] });
  return { commands, e2eLimitations };
}

/** Runs the real command matrix with immutable input rechecks; changed generated source never yields a receipt. */
export function executeChecks(value: ReturnType<typeof syncContext>, receipt: MainSyncReceipt) {
  const before = committedInputs(value.place.root);
  const recipe = checkRecipe(value, receipt);
  const results = [];
  for (const [index, command] of recipe.commands.entries()) {
    assertIdentity(value.place.root, before);
    const env = { ...process.env, TURBO_CONCURRENCY: "2" };
    Reflect.deleteProperty(env, "AFFECTED_SCRIPT_SUITES");
    Object.assign(env, command.bindings);
    const result = spawnSync(command.argv[0]!, command.argv.slice(1), { cwd: command.cwd ? join(value.place.root, command.cwd) : value.place.root, encoding: "utf8",
      timeout: command.timeoutMs ?? MAX_CHECK_MS, maxBuffer: 16 * 1024 * 1024,
      env });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const log = join(value.place.dir, `vibe-main-sync-${receipt.transactionId}-${index}.log`);
    writeFileSync(log, output, { mode: 0o600 });
    if (result.error || result.status !== 0) throw new MainSyncError(`Required validation command failed: ${command.argv.join(" ")}; private log ${log}`);
    assertIdentity(value.place.root, before);
    if (command.argv[1] === "turbo") {
      const dry = spawnSync("pnpm", [...command.argv.slice(1), "--dry=json"], { cwd: value.place.root, encoding: "utf8",
        timeout: MAX_CHECK_MS, maxBuffer: 16 * 1024 * 1024 });
      if (dry.status !== 0 || dry.error) throw new MainSyncError("Could not bind the actual pinned Turbo task selection");
      const selection = turboTasksSchema.parse(JSON.parse(dry.stdout));
      if (!selection.tasks.length && git(value.place.root, ["diff", "--name-only", receipt.validationSince, "HEAD"])) {
        throw new MainSyncError("Pinned validation selected no tasks for changed inputs; no executed coverage was established");
      }
      writeFileSync(`${log}.selection.json`, JSON.stringify(selection), { mode: 0o600 });
    }
    results.push({ argv: command.argv, ...(command.bindings ? { bindings: command.bindings } : {}),
      ...(command.cwd ? { cwd: command.cwd } : {}), exitCode: 0 as const, log, sha256: digest(output) });
  }
  assertIdentity(value.place.root, before);
  return { ...before, commands: results, checkedAt: new Date().toISOString(), e2eLimitations: recipe.e2eLimitations };
}

function assertIdentity(root: string, expected: ReturnType<typeof committedInputs>) {
  const current = committedInputs(root);
  if (current.headSha !== expected.headSha || current.treeSha !== expected.treeSha || current.inputSha256 !== expected.inputSha256) {
    throw new MainSyncError("Committed validation inputs changed during the operation; same-writer recheck required", "NEEDS_CHANGE");
  }
}
