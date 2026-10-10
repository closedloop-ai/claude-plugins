import { storedValidationRecipeSchema, type StoredValidationRecipe, type ValidationWitness, type recoveryReserveSchema } from "./main-sync-validation-contracts.js";
import type { z } from "zod";
import { digest } from "./main-sync-state.js";
import { MainSyncError } from "./main-sync-contracts.js";

/** Canonical digest binds actual selected commands, budgets and required coverage limitations together. */
export function recipeIdentity(value: Pick<StoredValidationRecipe, "commands" | "e2eLimitations" | "recovery">) {
  return digest(JSON.stringify({ commands: value.commands, e2eLimitations: value.e2eLimitations,
    ...(value.recovery ? { recovery: value.recovery } : {}) }));
}

export function storedRecipe(identity: { headSha: string; treeSha: string; inputSha256: string },
  recipe: Pick<StoredValidationRecipe, "commands" | "e2eLimitations" | "recovery">) {
  return storedValidationRecipeSchema.parse({ ...identity, ...recipe, recipeSha256: recipeIdentity(recipe) });
}

/** No commands/duration/PASS can be supplied in the Root witness; it identifies existing canonical data only. */
export function verifyRecipeWitness(recipe: StoredValidationRecipe, witness: ValidationWitness, transactionId: string) {
  if (witness.transactionId !== transactionId || recipe.headSha !== witness.headSha || recipe.treeSha !== witness.treeSha
    || recipe.inputSha256 !== witness.inputSha256 || recipe.recipeSha256 !== witness.recipeSha256
    || recipeIdentity(recipe) !== recipe.recipeSha256) throw new MainSyncError("Canonical validation recipe/witness identity changed", "NEEDS_CHANGE");
}

/** Existing fixed matrix bounds plus existing general overhead; no caller-controlled multiplier or deadline. */
export function validationEnvelopeMs(recipe: StoredValidationRecipe) {
  let total = 15 * 60 * 1000 + 120000 + 2000;
  if (recipe.recovery) {
    if (recipe.recovery.timeoutMs !== recoveryBudgetMs(recipe.recovery.owners)) throw new MainSyncError("Canonical recovery reserve is not derived from its fixed owners");
    total += recipe.recovery.timeoutMs;
  }
  for (const command of recipe.commands) {
    total += command.timeoutMs;
    if (command.argv[0] === "pnpm" && command.argv[1] === "turbo") total += 15 * 60 * 1000;
    if (command.argv.join(" ") === "pnpm typecheck:affected") total += 15 * 60 * 1000 + 10000;
  }
  if (!Number.isSafeInteger(total) || total <= 0 || total > 2 ** 31 - 1) throw new MainSyncError("Canonical validation envelope is not finite");
  return total;
}

/** One shared cold lifecycle and each actual selected owner invocation, never per-command retries. */
export function recoveryBudgetMs(owners: z.infer<typeof recoveryReserveSchema>["owners"]) {
  const needsCold = owners.some((id) => id !== "desktop-build" && id !== "desktop-migrations");
  let total = needsCold ? 3 * 15 * 60 * 1000 : 0;
  for (const id of owners) {
    if (id === "fumadocs") total += 2 * 15 * 60 * 1000;
    else if (id.startsWith("next-") || id === "desktop-docs") total += 15 * 60 * 1000;
    else total += 10000;
  }
  return total;
}
