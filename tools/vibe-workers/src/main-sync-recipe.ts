import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { providerDataOr, sessionBinding } from "../../../plugins/vibe-core/lib/vibe/scripts/provider.mjs";
import { agentsTestCommand, LOCKFILE_INSTALLS } from "../../../plugins/vibe-core/lib/vibe/scripts/repository-commands.mjs";
import { MainSyncError } from "./main-sync-contracts.js";

const argvSchema = z.array(z.string().min(1)).min(1).max(256);
const producerSchema = z.object({ id: z.string().min(1), roots: z.array(z.string().min(1)).min(1), inputs: z.array(z.string().min(1)),
  argv: argvSchema.optional(), package: z.object({ dir: z.string().min(1), name: z.string().min(1) }).strict().optional(),
  strategy: z.enum(["pristine", "full-write", "pure"]), refreshable: z.boolean().optional() }).strict();
const stepSchema = z.union([
  z.object({ argv: argvSchema, when: z.string().min(1).optional() }).strict(),
  z.object({ biome: z.literal(true) }).strict(),
  z.object({ laneDiscovery: z.literal(true) }).strict(),
]);
const recipeSchema = z.object({
  producers: z.array(producerSchema).default([]),
  reportOutputs: z.array(z.string().min(1)).default([]),
  runner: argvSchema.optional(),
  bootstrap: argvSchema.optional(),
  pristineEmpty: z.array(z.string().min(1)).default([]),
  checks: z.object({ build: z.array(stepSchema), prototype: z.array(stepSchema), handoff: z.array(stepSchema),
    final: z.array(stepSchema) }).strict().optional(),
  laneDiscovery: z.literal(true).optional(),
  desktopLane: z.object({ dir: z.string().min(1), script: z.string().min(1), postMergeCoverage: z.string().min(1) }).strict().optional(),
  ci: z.object({ workflow: z.string().min(1) }).strict().optional(),
  testHistory: z.string().min(1).optional(),
}).strict();

export type MainSyncRecipe = z.infer<typeof recipeSchema>;
export type MainSyncStep = z.infer<typeof stepSchema>;

/** Test and runner reports any repository's tools write; a recipe adds the repository's own. */
const GENERIC_REPORT_OUTPUTS = [".vitest/blob/blob.json", ".vitest/json/output.json", "playwright-report/index.html",
  "playwright-results.json", "test-results/.last-run.json"];
const PLAIN_COMMAND = /^[\w./:@=+,-]+(?: [\w./:@=+,-]+)*$/;

/**
 * The repository's main-sync recipe: the session provider's `recipes.mainSync` (its generated inputs, report
 * outputs, check matrix, lane discovery, Desktop lane and CI producer), or the generic one with none of them.
 */
export function mainSyncRecipe(root: string): MainSyncRecipe {
  const cached = recipes.get(root);
  if (cached) return cached;
  const raw = providerDataOr<unknown>(sessionBinding(root), "recipes", "mainSync", {});
  const parsed = recipeSchema.safeParse(raw);
  if (!parsed.success) throw new MainSyncError("The provider's main-sync recipe does not match its contract");
  // A session's binding is fixed for the process; the cap bounds a run that touches many checkouts.
  if (recipes.size >= RECIPE_CACHE_LIMIT) recipes.delete(recipes.keys().next().value!);
  recipes.set(root, parsed.data);
  return parsed.data;
}

const RECIPE_CACHE_LIMIT = 16;
const recipes = new Map<string, MainSyncRecipe>();

/** Every report output main sync treats as retained evidence in the repository at `root`. */
export function reportOutputsFor(root: string): ReadonlySet<string> {
  return new Set([...GENERIC_REPORT_OUTPUTS, ...mainSyncRecipe(root).reportOutputs]);
}

/** The recipe's bootstrap, else the install the repository's lockfile asks for, else none. */
export function bootstrapFor(root: string, checkout = root): readonly string[] | null {
  const declared = mainSyncRecipe(root).bootstrap;
  if (declared) return declared;
  const found = LOCKFILE_INSTALLS.find(([lockfile]) => existsSync(join(checkout, lockfile)));
  return found ? [found[1], ...found[2]] : null;
}

/**
 * The check steps for a purpose. A recipe states them; without one the build loop runs none (the commit hooks run
 * the repository's own checks) and every other purpose runs the test command the repository's AGENTS.md documents.
 */
export function checkSteps(root: string, purpose: "build" | "prototype" | "handoff"): { steps: MainSyncStep[]; final: MainSyncStep[] } {
  const checks = mainSyncRecipe(root).checks;
  if (checks) return { steps: checks[purpose], final: purpose === "build" ? [] : checks.final };
  if (purpose === "build") return { steps: [], final: [] };
  const agents = join(root, "AGENTS.md");
  const command = existsSync(agents) ? agentsTestCommand(readFileSync(agents, "utf8")) : null;
  if (!command) return { steps: [], final: [] };
  return { steps: [{ argv: PLAIN_COMMAND.test(command) ? command.split(" ") : ["sh", "-c", command] }], final: [] };
}

/**
 * Why a publication sync ran no check at all, or null: with no recipe and no test command in AGENTS.md a handoff
 * or prototype sync has nothing to run, which is unsupported, never a pass. The build loop leaves checks to the hooks.
 */
export function uncheckedReason(purpose: string, commandCount: number): string | null {
  if (purpose === "build" || commandCount > 0) return null;
  return "the repository names no check for main sync to run (no recipe, and no test command in AGENTS.md)";
}
