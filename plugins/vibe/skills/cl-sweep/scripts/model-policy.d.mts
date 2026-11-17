import type { ModelOverrideOptions } from "../../vibe/scripts/agent-models.mjs";

export const TICKET_OWNER_MODEL: string;
export const HIGH_COMPLEXITY_REVIEW_MODEL: string;
export const CODEX_FALLBACK_MODELS: Readonly<Record<string, string>>;
export const Complexity: Readonly<{ Low: "LOW"; Medium: "MEDIUM"; High: "HIGH" }>;
export type ModelCatalog = { models: string[] } | { error: string };
export function availableCodexModel(model: string, catalog?: ModelCatalog): { model: string; fallbackFrom: string | null; note: string | null };
export function laneModel(role: string, options?: ModelOverrideOptions & { complexity?: string }): { model: string; reasoningEffort: string };
export const EXPLORER_MODEL: string;
export const MECHANICAL_SUPPORT_MODEL: string;
export const DEFAULT_REASONING_EFFORT: string;
export const MECHANICAL_SUPPORT_REASONING_EFFORT: string;
export const CODEX_ROLE_BINDINGS: Readonly<Record<string, Readonly<{ model: string; reasoningEffort: string }>>>;
export function validateModelName(value: unknown, label: string): string;
export function ticketOwnerModel(options?: ModelOverrideOptions & { launchModel?: string }): string;
export type SavedModelSession = { requestedModel?: unknown; requestedModelExplicit?: unknown; requestedModelFallbackFrom?: unknown };
export function validateModelFallback(session: SavedModelSession): void;
export function ticketOwnerNeedsReplacement(session: SavedModelSession): boolean;
export function assertNoReplacementNeeded(session: SavedModelSession): void;
export function ticketOwnerReplacementStatus(session: SavedModelSession, idleCandidate: boolean): {
  modelReplacement: { targetModel: string; requiredBeforeNextTurn: true; idleCandidate: boolean } | null;
  modelReplacementError: string | null;
};
export function codexBindingForRole(role: string): Readonly<{ model: string; reasoningEffort: string }>;
