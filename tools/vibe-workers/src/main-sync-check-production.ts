import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CheckCommand } from "./main-sync-lanes.js";
import { MainSyncError, type MainSyncReceipt } from "./main-sync-contracts.js";
import { inspectInputInventory, verifyOriginProof } from "./main-sync-checks.js";
import { producerFiles } from "./main-sync-input-catalog.js";
import { originIdentity, sameOriginFiles } from "./main-sync-input-files.js";
import { prepareInputOrigins } from "./main-sync-input-origin.js";
import { requireSyncReceipt, saveSyncReceipt, syncContext } from "./main-sync-state.js";
import { commandSelection } from "./main-sync-budget.js";
import { recoveryBudgetMs } from "./main-sync-validation-recipe.js";
import { recoveryOwnerSchema } from "./main-sync-validation-contracts.js";
import { presentProducers } from "./main-sync-input-catalog.js";

const packageSchema = z.object({ scripts: z.record(z.string()).optional() }).passthrough();
type Selection = { tasks: { taskId: string; package?: string }[] };

/** Generated changes get no check credit until canonical origin is re-established and the matrix runs again. */
export function recheckSelectedProduction(value: ReturnType<typeof syncContext>, receipt: MainSyncReceipt,
  command: CheckCommand, selection: Selection | undefined, eligible: readonly string[]) {
  const root = value.place.root;
  const current = inspectInputInventory(root);
  const previous = requireSyncReceipt(value).inputs;
  if (!previous || current.headSha !== previous.headSha || current.treeSha !== previous.treeSha
    || current.inputSha256 !== previous.trackedInputSha256) throw new MainSyncError("Tracked inputs changed during validation", "NEEDS_CHANGE");
  const allowed = new Set(previous.files.map((file) => file.path));
  const changed = current.producers.filter((producer) => !sameOriginFiles(producerFiles(root, producer, allowed),
    previous.files.filter((file) => producer.roots.some((path) => file.path === path || file.path.startsWith(`${path}/`)))));
  if (!changed.length || changed.some((producer) => !eligible.includes(producer.id) || !selectedProducer(root, producer.id, command, selection))) {
    throw new MainSyncError("Generated mutation has no exact selected canonical producer; source readiness required", "NEEDS_CHANGE");
  }
  const changedIds = new Set(changed.map((producer) => producer.id));
  verifyOriginProof(root, value.place.dir, current, previous, changedIds);
  const refreshed = prepareInputOrigins(value, current, changed);
  verifyOriginProof(root, value.place.dir, inspectInputInventory(root), previous, changedIds);
  const producers = previous.producers.map((producer) => refreshed.producers.find((item) => item.id === producer.id) ?? producer);
  const files = producers.flatMap((producer) => (changedIds.has(producer.id) ? refreshed.files : previous.files)
    .filter((file) => producer.files.includes(file.path)));
  const packages = [...previous.packages];
  for (const owner of refreshed.packages) {
    const existing = packages.find((item) => item.path === owner.path);
    if (existing && JSON.stringify(existing) !== JSON.stringify(owner)) throw new MainSyncError("Recovery canonical package owner conflicts", "NEEDS_CHANGE");
    if (!existing) packages.push(owner);
  }
  const inputs = { ...previous, checkedAt: refreshed.checkedAt, producers, files, packages,
    inputSha256: originIdentity(previous.trackedInputSha256, files, packages) };
  verifyOriginProof(root, value.place.dir, inspectInputInventory(root), inputs);
  const active = requireSyncReceipt(value);
  if (active.transactionId !== receipt.transactionId) throw new MainSyncError("Canonical production transaction changed", "NEEDS_CHANGE");
  const next = { ...active, inputs };
  delete next.validation;
  delete next.ciEvidence;
  delete next.recipe;
  saveSyncReceipt(value.place.dir, next);
}

/** Only a selected typecheck task with its canonical producer prefix can explain output mutation. */
export function selectedProducer(root: string, id: string, command: CheckCommand, selection: Selection | undefined) {
  const direct = command.argv[0] === "pnpm" && command.argv[1] === "turbo" && command.argv[2] === "typecheck";
  if ((!direct && command.argv.join(" ") !== "pnpm typecheck:affected") || !selection) return false;
  const owner = id === "fumadocs" ? "web" : id === "next-api" ? "api" : id === "next-app" ? "app" : id.startsWith("desktop-") ? "desktop" : undefined;
  if (!owner || !selection.tasks.some((task) => task.package === owner && task.taskId.endsWith("#typecheck"))) return false;
  const script = packageSchema.parse(JSON.parse(readFileSync(join(root, "apps", owner, "package.json"), "utf8"))).scripts?.typecheck;
  const first = script?.split("&&")[0]?.trim();
  if (owner === "web") return first === "fumadocs-mdx";
  if (owner === "app" || owner === "api") return first === "next typegen";
  // These identities name the already committed Desktop prebuild owner; the pristine verifier still binds every body.
  return first === "pnpm prebuild" && id !== "desktop-prisma";
}

/** Canonical matrix selection determines the only owners eligible for the existing single restart. */
export function selectedRecoveryReserve(root: string, commands: CheckCommand[]) {
  const present = presentProducers(root);
  const eligible = new Set<string>();
  if (present.length) for (const command of commands) {
    if (command.argv.join(" ") !== "pnpm typecheck:affected"
      && !(command.argv[0] === "pnpm" && command.argv[1] === "turbo" && command.argv[2] === "typecheck")) continue;
    const selection = commandSelection(root, command, 120000);
    for (const producer of present) if (selectedProducer(root, producer.id, command, selection)) eligible.add(producer.id);
  }
  const owners = [...eligible].sort().map((id) => recoveryOwnerSchema.parse(id));
  return { owners, timeoutMs: recoveryBudgetMs(owners) };
}
