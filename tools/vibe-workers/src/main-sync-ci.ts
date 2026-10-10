import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { z } from "zod";
import { ciEvidenceSchema, commitSchema, MainSyncError } from "./main-sync-contracts.js";
import { checkedSourceFromJobLog, ciStepSchema, type CiStep } from "./main-sync-ci-logs.js";
import { digest, type syncContext } from "./main-sync-state.js";

const REPOSITORY = "closedloop-ai/symphony-alpha";
const WORKFLOW = ".github/workflows/e2e-test.yml";
// Exact reviewed Run Electron e2e body at loaded-main 02a7ae03 and e5fc4f7, including both verdict guards.
const REVIEWED_ELECTRON_RUN_SHA256 = "d42acd228f3da95e0d05b419b0c8f38f36c2233fbf49c3113de6aae1e4697912";
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
  uses: z.string().optional(), run: z.string().optional(), env: z.record(z.unknown()).optional() }).passthrough();
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
  const definition = producerSchema.parse(parse(Buffer.from(contents.content, "base64").toString("utf8")));
  const steps = definition.jobs["desktop-e2e"].steps;
  const checkout = only(steps.filter((step) => step.name === "Checkout repository"));
  const resolve = only(steps.filter((step) => step.id === "target-ref"));
  const test = only(steps.filter((step) => step.name === "Run Electron e2e"));
  if (!checkout.uses?.startsWith("actions/checkout@") || !resolve.run?.includes('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"')
    || test.env?.DD_GIT_COMMIT_SHA !== "${{ steps.target-ref.outputs.sha }}" || !test.run
    || digest(test.run) !== REVIEWED_ELECTRON_RUN_SHA256) {
    throw new MainSyncError("Pinned loaded-main CI producer has no recognized trusted source/verdict interface");
  }
  const jobs = jobsSchema.parse(apiJson(root, `repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${locator.attempt}/jobs?per_page=100`));
  if (jobs.jobs.length !== jobs.total_count) throw new MainSyncError("Required CI job set is incomplete");
  const desktop = only(jobs.jobs.filter((job) => job.name === "desktop-e2e"));
  requireJob(desktop, run.id, locator.attempt);
  const checkoutStep = requiredStep(desktop.steps, "Checkout repository");
  requiredStep(desktop.steps, "Resolve target ref");
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
