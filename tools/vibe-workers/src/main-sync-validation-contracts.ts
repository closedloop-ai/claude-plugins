import { z } from "zod";

export const validationCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const validationDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const validationWitnessSchema = z.object({ operation: z.literal("main-sync-validate"),
  transactionId: z.string().uuid(), headSha: validationCommitSchema, treeSha: validationCommitSchema,
  inputSha256: validationDigestSchema, recipeSha256: validationDigestSchema }).strict();
export type ValidationWitness = z.infer<typeof validationWitnessSchema>;
export const fixedCommandSchema = z.object({ argv: z.array(z.string().min(1).max(8192)).min(1).max(256),
  bindings: z.record(z.string()).optional(), cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(186 * 60 * 1000) }).strict();
export const recoveryOwnerSchema = z.enum(["next-api", "next-app", "fumadocs", "desktop-build", "desktop-migrations", "desktop-docs", "desktop-auth"]);
export const recoveryReserveSchema = z.object({ owners: z.array(recoveryOwnerSchema).max(7)
  .refine((owners) => new Set(owners).size === owners.length && owners.every((owner, index) => index === 0 || owners[index - 1]! < owner), "Canonical recovery owners must be uniquely sorted"),
  timeoutMs: z.number().int().min(0).max(15 * 15 * 60 * 1000) }).strict();
export const storedValidationRecipeSchema = z.object({ headSha: validationCommitSchema, treeSha: validationCommitSchema,
  inputSha256: validationDigestSchema, recipeSha256: validationDigestSchema,
  commands: z.array(fixedCommandSchema).min(1).max(128),
  recovery: recoveryReserveSchema.optional(),
  e2eLimitations: z.array(z.object({ argv: z.array(z.string()).min(1).max(256), bindings: z.record(z.string()).optional(),
    reason: z.string().min(1).max(4096) }).strict()).max(128) }).strict();
export type StoredValidationRecipe = z.infer<typeof storedValidationRecipeSchema>;
