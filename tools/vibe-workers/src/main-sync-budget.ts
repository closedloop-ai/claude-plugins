import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { createHash } from "node:crypto";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { verifyReportExecution } from "./main-sync-report-inputs.js";
import { ReportExecutionOwner } from "./main-sync-report-execution.js";
import { MainSyncError, type MainSyncReceipt } from "./main-sync-contracts.js";
import type { CheckCommand } from "./main-sync-lanes.js";
import { readBudgetRefs } from "./main-sync-budget-ref-read.js";

export const GENERAL_CHECK_MS = 15 * 60 * 1000;
export const FULL_LOCAL_LINT_MS = 30 * 60 * 1000;
const shardJobSchema = z.object({ "timeout-minutes": z.number().int().min(1).max(60),
  strategy: z.object({ matrix: z.object({ shard: z.tuple([z.literal(1), z.literal(2), z.literal(3)]) }).passthrough() }).passthrough() }).passthrough();
const workflowSchema = z.object({ jobs: z.object({ "test-shard": shardJobSchema,
  "desktop-node": shardJobSchema,
  "desktop-renderer": z.object({ "timeout-minutes": z.number().int().min(1).max(60) }).passthrough() }).passthrough() }).passthrough();
const tasksSchema = z.object({ tasks: z.array(z.object({ taskId: z.string().min(1), package: z.string().min(1) }).passthrough()).max(50000) }).passthrough();
const affectedFilterSchema = z.string().regex(/^\.\.\.\[[a-f0-9]{40}\]$/);
const wrapperSchema = z.object({ scripts: z.record(z.string()) }).passthrough();
const AFFECTED_TYPECHECK_SHA = "01c2c50b267a071fa3ed193612c6d2c94f18fde6d01c78c6c47bfd81b56aad69";
const AFFECTED_TEST_SHA = "b1d8c482cb012520f93729cb6f760b3e6d4344d191f94d569e7300265e2955b5";
const testSelections = new WeakMap<CheckCommand, { root: string; head: string; mainSha: string; command: string; wrapperSha: string; selection: z.infer<typeof tasksSchema> }>();

/** The fixed affected owner and pinned direct Turbo have distinct real selectors. */
export function commandSelection(root: string, command: CheckCommand, timeoutMs = GENERAL_CHECK_MS) {
  let argv: string[];
  if (command.argv[0] === "pnpm" && command.argv[1] === "turbo") argv = [...command.argv.slice(1), "--dry=json"];
  else if (command.argv.join(" ") === "pnpm typecheck:affected") {
    const pkg = wrapperSchema.parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    if (pkg.scripts["typecheck:affected"] !== "sh scripts/typecheck-affected.sh"
      || createHash("sha256").update(readFileSync(join(root, "scripts/typecheck-affected.sh"))).digest("hex") !== AFFECTED_TYPECHECK_SHA) {
      throw new MainSyncError("Affected typecheck wrapper owner changed; no selected producer authority", "NEEDS_CHANGE");
    }
    argv = ["turbo", "typecheck", `--filter=${affectedFilter(root)}`, "--concurrency=1", "--dry=json"];
  } else return undefined;
  verifyReportExecution(root, root, ReportExecutionOwner.TurboSelection, ["pnpm", ...argv]);
  const run = spawnSync("pnpm", argv, { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new MainSyncError("Could not bind the actual canonical Turbo task selection");
  return tasksSchema.parse(JSON.parse(run.stdout));
}

function affectedFilter(root: string) {
  verifyReportExecution(root, root, ReportExecutionOwner.AffectedFilter, ["sh", "scripts/affected-filter.sh"]);
  const selected = spawnSync("sh", ["scripts/affected-filter.sh"], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  if (selected.error || selected.status !== 0) throw new MainSyncError("Existing affected-filter owner failed; no selection was derived");
  return affectedFilterSchema.parse(selected.stdout.trim());
}

/** Fixed command budgets come from the real selected matrix, never task text, env or caller duration. */
export function bindCheckBudgets(root: string, receipt: MainSyncReceipt, commands: CheckCommand[]) {
  const aggregates = new Map<string, ReturnType<typeof selectedTestBudget>>();
  return commands.map((command) => {
    if (command.argv.join(" ") === "pnpm test:lint" && !command.bindings?.AFFECTED_SCRIPT_SUITES) {
      return { ...command, timeoutMs: FULL_LOCAL_LINT_MS };
    }
    if (command.argv[0] === "pnpm" && (command.argv[1] === "test:affected"
      || (command.argv[1] === "turbo" && command.argv[2] === "test"))) {
      const key = command.argv[1] === "test:affected" ? "affected" : receipt.validationSince;
      let budget = aggregates.get(key);
      if (budget === undefined) {
        budget = selectedTestBudget(root, receipt, key === "affected");
        aggregates.set(key, budget);
      }
      const bound = { ...command, timeoutMs: budget.timeoutMs };
      if (key === "affected" && canonicalTestWrapper(root)) {
        testSelections.set(bound, { root, head: budget.head, mainSha: receipt.mainSha, command: JSON.stringify(bound), wrapperSha: testWrapperIdentity(root), selection: budget.selection });
      }
      return bound;
    }
    return { ...command, timeoutMs: command.timeoutMs ?? GENERAL_CHECK_MS };
  });
}

// operator ruling, 2026-10-16: the affected selection is pinned to the transaction's captured
// mainSha. The live origin/main moves every few minutes and only its merge-base with HEAD reaches
// the affected wrapper, so a fast-forward of main leaves the selection unchanged; HEAD is the guard.
function selectedTestBudget(root: string, receipt: MainSyncReceipt, affected: boolean) {
  const { head } = readBudgetRefs(root);
  const workflow = workflowSchema.parse(parse(readFileSync(join(root, ".github/workflows/pr-test.yml"), "utf8")));
  let filter = `...[${receipt.validationSince}]`;
  if (affected) {
    filter = affectedFilter(root);
    if (filter !== `...[${receipt.mainSha}]`) {
      throw new MainSyncError("Affected test selection is not pinned to the captured main", "NEEDS_CHANGE");
    }
  }
  verifyReportExecution(root, root, ReportExecutionOwner.TurboSelection, ["pnpm", "turbo", "test", `--filter=${filter}`, "--dry=json"]);
  const run = spawnSync("pnpm", ["turbo", "test", `--filter=${filter}`, "--dry=json"], {
    cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) throw new MainSyncError("Could not derive fixed test budget from actual selected Turbo tasks");
  const selection = tasksSchema.parse(JSON.parse(run.stdout));
  if (head !== git(root, ["rev-parse", "HEAD"])) {
    throw new MainSyncError("Test selection refs changed during the owning budget child", "NEEDS_CHANGE");
  }
  const tasks = selection.tasks;
  const packages = new Set(tasks.map((task) => task.package));
  let minutes = 0;
  if ([...packages].some((name) => name !== "desktop")) {
    minutes += workflow.jobs["test-shard"]["timeout-minutes"] * workflow.jobs["test-shard"].strategy.matrix.shard.length;
  }
  if (packages.has("desktop")) {
    minutes += workflow.jobs["desktop-node"]["timeout-minutes"] * workflow.jobs["desktop-node"].strategy.matrix.shard.length
      + workflow.jobs["desktop-renderer"]["timeout-minutes"];
  }
  return { timeoutMs: minutes ? minutes * 60 * 1000 : GENERAL_CHECK_MS, selection, head };
}

/** Reuses the budget owner's actual task record without accepting caller metadata or another selector child. */
export function affectedTestReportSelection(root: string, command: CheckCommand) {
  const record = testSelections.get(command);
  if (!record) return undefined;
  if (record.root !== root || record.head !== git(root, ["rev-parse", "HEAD"]) || wrapperBase(root) !== record.mainSha
    || record.command !== JSON.stringify(command) || record.wrapperSha !== testWrapperIdentity(root)
    || !canonicalTestWrapper(root)) throw new MainSyncError("Affected test selection owner changed before its report assessment", "NEEDS_CHANGE");
  return record.selection;
}

/** The base the affected wrapper selects from when it runs; a moved but descendant origin/main keeps it. */
function wrapperBase(root: string) {
  try { return git(root, ["merge-base", "origin/main", "HEAD"]); }
  catch { return undefined; }
}

function testWrapperIdentity(root: string) {
  return createHash("sha256").update(readFileSync(join(root, "scripts/test-affected.sh"))).digest("hex");
}

function canonicalTestWrapper(root: string) {
  const pkg = wrapperSchema.parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
  if (pkg.scripts["test:affected"] !== "sh scripts/test-affected.sh") return false;
  return testWrapperIdentity(root) === AFFECTED_TEST_SHA;
}
