import { spawnSync } from "node:child_process";
import { parse, parseDocument } from "yaml";
import { z } from "zod";
import { ciEvidenceSchema, commitSchema, MainSyncError } from "./main-sync-contracts.js";
import { checkedSourceFromJobLog, ciStepSchema, type CiStep } from "./main-sync-ci-logs.js";
import { digest, type syncContext } from "./main-sync-state.js";

const REPOSITORY = "closedloop-ai/symphony-alpha";
const WORKFLOW = ".github/workflows/e2e-test.yml";
// Exact reviewed Run Electron e2e body at loaded-main 02a7ae03, e5fc4f7 and 51f4d122ba, including both verdict guards.
const REVIEWED_ELECTRON_RUN_SHA256 = "d42acd228f3da95e0d05b419b0c8f38f36c2233fbf49c3113de6aae1e4697912";
// The desktop-e2e checkout ref at loaded-main 51f4d122ba: a dispatch on main tests the `ref` input it names.
export const REVIEWED_CHECKOUT_REF = "${{ github.event.merge_group.head_sha || github.event.pull_request.head.sha || github.event.inputs.ref || (github.event_name == 'schedule' && github.sha) || github.ref }}";
const SAFE_ID = z.number().int().positive().safe();
const identitySchema = z.object({ full_name: z.literal(REPOSITORY) }).passthrough();
const workflowSchema = z.object({ id: SAFE_ID, path: z.literal(WORKFLOW) }).passthrough();
const runSchema = z.object({ id: SAFE_ID, event: z.enum(["workflow_dispatch", "schedule"]),
  status: z.literal("completed"), conclusion: z.literal("success"), head_branch: z.literal("main"),
  head_sha: commitSchema, path: z.literal(WORKFLOW), workflow_id: SAFE_ID, run_attempt: SAFE_ID,
  repository: identitySchema, head_repository: identitySchema }).passthrough();
const jobSchema = z.object({ id: SAFE_ID, run_id: SAFE_ID, run_attempt: SAFE_ID, name: z.string(),
  status: z.string(), conclusion: z.string().nullable(), steps: z.array(ciStepSchema).max(100) }).passthrough();
const jobsSchema = z.object({ total_count: z.number().int().nonnegative().max(100), jobs: z.array(jobSchema).max(100) }).passthrough();
const contentsSchema = z.object({ encoding: z.literal("base64"), content: z.string().min(1) }).passthrough();
const producerStepSchema = z.object({ name: z.string().optional(), id: z.string().optional(),
  uses: z.string().optional(), run: z.string().optional(), env: z.record(z.unknown()).optional(),
  with: z.record(z.unknown()).optional() }).passthrough();
const producerSchema = z.object({ jobs: z.object({ "desktop-e2e": z.object({ steps: z.array(producerStepSchema) }).passthrough() }).passthrough() }).passthrough();

/** Reads canonical live GitHub evidence for the actual grant's locator; it cannot dispatch or accept an attestation. */
export function verifyExternalCi(value: ReturnType<typeof syncContext>, input: { headSha: string; treeSha: string; inputSha256: string }) {
  const locator = value.context.mainSyncCiRun;
  if (!locator || value.purpose !== "handoff") throw new MainSyncError("Handoff required E2E is incomplete; Root-bound real CI evidence is needed");
  const root = value.place.root;
  const workflow = workflowSchema.parse(apiJson(root, `repos/${REPOSITORY}/actions/workflows/e2e-test.yml`));
  const run = runSchema.parse(apiJson(root, `repos/${REPOSITORY}/actions/runs/${locator.runId}`));
  if (run.id !== locator.runId || run.run_attempt !== locator.attempt || run.workflow_id !== workflow.id) {
    throw new MainSyncError("CI run/workflow/attempt differs from the actual source grant");
  }
  const contents = contentsSchema.parse(apiJson(root, `repos/${REPOSITORY}/contents/${WORKFLOW}?ref=${run.head_sha}`));
  const test = reviewedProducer(Buffer.from(contents.content, "base64").toString("utf8"));
  const jobs = jobsSchema.parse(apiJson(root, `repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${locator.attempt}/jobs?per_page=100`));
  if (jobs.jobs.length !== jobs.total_count) throw new MainSyncError("Required CI job set is incomplete");
  const desktop = only(jobs.jobs.filter((job) => job.name === "desktop-e2e"));
  requireJob(desktop, run.id, locator.attempt);
  const checkoutStep = requiredStep(desktop.steps, "Checkout repository");
  const testStep = requiredStep(desktop.steps, "Run Electron e2e");
  const log = apiText(root, `repos/${REPOSITORY}/actions/jobs/${desktop.id}/logs`, true);
  const checkoutSha = checkedSourceFromJobLog(log, checkoutStep, testStep, test.run.trimStart().split("\n")[0]!.trim());
  if (checkoutSha !== input.headSha) throw new MainSyncError("Actual CI checkout differs from the owned committed handoff result");
  const current = runSchema.parse(apiJson(root, `repos/${REPOSITORY}/actions/runs/${locator.runId}`));
  if (current.run_attempt !== run.run_attempt || current.workflow_id !== run.workflow_id || current.head_sha !== run.head_sha) {
    throw new MainSyncError("CI run identity changed during verification; no handoff completion was issued");
  }
  return ciEvidenceSchema.parse({ runId: run.id, attempt: locator.attempt, workflowId: workflow.id,
    definitionSha: run.head_sha, checkoutSha, treeSha: input.treeSha, inputSha256: input.inputSha256,
    verifiedAt: new Date().toISOString(), jobs: [{ jobId: desktop.id, name: desktop.name,
      conclusion: "success", logSha256: digest(log) }] });
}

/**
 * The loaded-main desktop-e2e producer's trusted interface: one checkout of the reviewed ref expression and one
 * reviewed Run Electron e2e body. Its checkout action's log names the tested source. Returns the test step.
 */
export function reviewedProducer(workflowText: string) {
  const steps = producerSchema.parse(parse(workflowText)).jobs["desktop-e2e"].steps;
  const checkout = only(steps.filter((step) => step.name === "Checkout repository"));
  const test = only(steps.filter((step) => step.name === "Run Electron e2e"));
  if (!checkout.uses?.startsWith("actions/checkout@") || checkout.with?.ref !== REVIEWED_CHECKOUT_REF
    || !test.run || digest(test.run) !== REVIEWED_ELECTRON_RUN_SHA256) {
    throw new MainSyncError("Pinned loaded-main CI producer has no recognized trusted source/verdict interface");
  }
  return { ...test, run: test.run };
}

function requiredStep(steps: CiStep[], name: string) {
  const step = only(steps.filter((item) => item.name === name));
  if (step.status !== "completed" || step.conclusion !== "success") throw new MainSyncError("Required CI step is missing, skipped, canceled or unsuccessful");
  return step;
}
function requireJob(job: z.infer<typeof jobSchema>, runId: number, attempt: number) {
  if (job.run_id !== runId || job.run_attempt !== attempt || job.status !== "completed" || job.conclusion !== "success") {
    throw new MainSyncError("Required CI job is missing, skipped, canceled or unsuccessful");
  }
}
function only<T>(items: T[]) {
  if (items.length !== 1) throw new MainSyncError("CI identity is missing or ambiguous");
  return items[0]!;
}
function apiJson(root: string, path: string): unknown { return JSON.parse(apiText(root, path)); }
function apiText(root: string, path: string, logs = false) {
  const result = spawnSync("gh", ["api", path, ...(logs ? ["--allow-escape-sequences"] : [])], {
    cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new MainSyncError("Real GitHub CI evidence could not be read; no coverage completion was issued");
  return result.stdout;
}


const workflowScalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const workflowRun = z.object({ "working-directory": z.string().optional(), shell: z.string().optional() }).strict();
const condition = z.union([z.string(), z.boolean()]).refine(value => {
  if (typeof value === "boolean") return true;
  let expression = value.trim();
  if (expression.startsWith("${{") && expression.endsWith("}}")) expression = expression.slice(3, -2).trim();
  return /^(?:true|false|always\(\)|success\(\)|failure\(\)|cancelled\(\))$/.test(expression)
    || /^github\.event_name\s*(?:==|!=)\s*(['"])[a-z_]+\1$/.test(expression);
}, "unsupported workflow condition");
const workflowStep = z.object({ run: z.string().min(1).optional(), uses: z.string().min(1).optional(),
  with: z.record(workflowScalar).optional(), name: z.string().optional(), id: z.string().optional(),
  "working-directory": z.string().optional(), shell: z.string().optional(), env: z.record(workflowScalar).optional(),
  if: condition.optional(), "timeout-minutes": z.number().int().positive().optional(), "continue-on-error": z.boolean().optional(),
}).strict().refine(step => Boolean(step.run) !== Boolean(step.uses), "step needs exactly one run or uses")
  .refine(step => !step.run || step.with === undefined, "run steps cannot have action inputs")
  .refine(step => !step.uses || step.shell === undefined && step["working-directory"] === undefined, "action steps cannot have shell/cwd");
const workflowJob = z.object({ steps: z.array(workflowStep).min(1), env: z.record(workflowScalar).optional(), name: z.string().optional(),
  "runs-on": z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]), if: condition.optional(),
  "timeout-minutes": z.number().int().positive().optional(), "continue-on-error": z.boolean().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(), permissions: z.union([z.string(), z.record(z.string())]).optional(),
  defaults: z.object({ run: workflowRun.optional() }).strict().optional(),
  strategy: z.object({ matrix: z.record(z.unknown()).optional(), "fail-fast": z.boolean().optional(), "max-parallel": z.number().int().positive().optional() }).strict().optional(),
}).strict(); // Reusable jobs, containers, services and dynamic runner semantics need a verified adapter first.
const concurrency = z.union([z.string(), z.object({ group: z.string(), "cancel-in-progress": z.boolean().optional() }).strict()]);
const laneWorkflow = z.object({ jobs: z.record(workflowJob), env: z.record(workflowScalar).optional(),
  name: z.string().optional(), on: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]), concurrency: concurrency.optional(), permissions: z.union([z.string(), z.record(z.string())]).optional(),
  "run-name": z.string().optional(), defaults: z.object({ run: workflowRun.optional() }).strict().optional(),
}).strict();
type WorkflowLane = { name: string; job: string; matrix: Record<string, string | number | boolean>; command: string };

/** Bind the entire supported declared execution shape, not just shell steps. This identifies a definition, not proof of execution. */
export function workflowLaneDefinitions(source: string): WorkflowLane[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error("invalid/unsupported workflow YAML");
  const workflow = laneWorkflow.parse(document.toJS({ maxAliasCount: 0 }));
  const { jobs, ...globals } = workflow;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort().map(([key, item]) => [key, canonical(item)]));
    if (value !== null && !["string", "boolean", "number"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("non-JSON workflow execution field");
    }
    return value;
  };
  const lanes: WorkflowLane[] = [];
  for (const [job, value] of Object.entries(jobs)) {
    const matrix = value.strategy?.matrix;
    let rows: Record<string, string | number | boolean>[] = [{}];
    if (matrix) {
      if (Object.keys(matrix).length !== 1 || !Array.isArray(matrix.include)) throw new Error("unsupported workflow matrix; use literal include rows");
      rows = z.array(z.record(workflowScalar)).min(1).max(100).parse(matrix.include);
    }
    for (const row of rows) {
      const expand = (input: unknown, at: string[] = []): unknown => {
        if (Array.isArray(input)) return input.map((item, index) => expand(item, [...at, String(index)]));
        if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([field, item]) => [field, expand(item, [...at, field])]));
        if (typeof input !== "string") return input;
        const text = input.replace(/\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, field: string) => {
          if (row[field] === undefined) throw new Error("unknown workflow matrix operand"); return String(row[field]);
        });
        if (/\$\{\{/.test(text)) {
          const run = at.length === 3 && at[0] === "steps" && at[2] === "run";
          const predicate = at.length === 1 && at[0] === "if" || at.length === 3 && at[0] === "steps" && at[2] === "if";
          if (!run && !predicate || run && [...text.matchAll(/\$\{\{(.*?)\}\}/g)].some(match => match[1]?.trim() !== "github.event.pull_request.base.ref")) {
            throw new Error("unsupported dynamic execution field");
          }
        }
        return text;
      };
      const expanded = workflowJob.parse(expand(value));
      const boundGlobals = { ...globals, ...(globals.env ? { env: expand(globals.env, ["env"]) } : {}), ...(globals.defaults ? { defaults: expand(globals.defaults, ["defaults"]) } : {}) };
      for (const step of expanded.steps) if (step.uses && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[A-Za-z0-9_./-]+$/.test(step.uses)) {
        throw new Error("unsupported local/dynamic action reference");
      }
      const name = Object.keys(row).length ? `${job}[${JSON.stringify(row)}]` : job;
      if (lanes.some(lane => lane.name === name)) throw new Error("duplicate workflow lane");
      lanes.push({ name, job, matrix: row, command: JSON.stringify(canonical({ version: 1, workflow: boundGlobals, job: expanded, matrix: row })) });
      if (lanes.length > 200) throw new Error("workflow lane expansion bound exceeded");
    }
  }
  if (!lanes.length) throw new Error("workflow has no lanes");
  return lanes;
}
