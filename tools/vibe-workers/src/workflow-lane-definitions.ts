import { parseDocument } from "yaml";
import { z } from "zod";

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
}).strict();
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
    if (value !== null && !["string", "boolean", "number"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new Error("non-JSON workflow execution field");
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
          if (!run && !predicate || run && [...text.matchAll(/\$\{\{(.*?)\}\}/g)].some(match => match[1]?.trim() !== "github.event.pull_request.base.ref")) throw new Error("unsupported dynamic execution field");
        }
        return text;
      };
      const expanded = workflowJob.parse(expand(value));
      const boundGlobals = { ...globals, ...(globals.env ? { env: expand(globals.env, ["env"]) } : {}), ...(globals.defaults ? { defaults: expand(globals.defaults, ["defaults"]) } : {}) };
      for (const step of expanded.steps) if (step.uses && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[A-Za-z0-9_./-]+$/.test(step.uses)) throw new Error("unsupported local/dynamic action reference");
      const name = Object.keys(row).length ? `${job}[${JSON.stringify(row)}]` : job;
      if (lanes.some(lane => lane.name === name)) throw new Error("duplicate workflow lane");
      lanes.push({ name, job, matrix: row, command: JSON.stringify(canonical({ version: 1, workflow: boundGlobals, job: expanded, matrix: row })) });
      if (lanes.length > 200) throw new Error("workflow lane expansion bound exceeded");
    }
  }
  if (!lanes.length) throw new Error("workflow has no lanes");
  return lanes;
}
