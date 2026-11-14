import type { ModelOverrideOptions } from "../../vibe/scripts/agent-models.mjs";

export const TICKET_OWNER_MODEL: string;
export const EXPLORER_MODEL: string;
export const MECHANICAL_SUPPORT_MODEL: string;
export const DEFAULT_REASONING_EFFORT: string;
export const MECHANICAL_SUPPORT_REASONING_EFFORT: string;
export const CODEX_ROLE_BINDINGS: Readonly<Record<string, Readonly<{ model: string; reasoningEffort: string }>>>;
export function validateModelName(value: unknown, label: string): string;
export function ticketOwnerModel(options?: ModelOverrideOptions & { launchModel?: string }): string;
export type SavedModelSession = { requestedModel?: unknown; requestedModelExplicit?: unknown };
export function ticketOwnerNeedsReplacement(session: SavedModelSession): boolean;
export function assertNoReplacementNeeded(session: SavedModelSession): void;
export function ticketOwnerReplacementStatus(session: SavedModelSession, idleCandidate: boolean): {
  modelReplacement: { targetModel: string; requiredBeforeNextTurn: true; idleCandidate: boolean } | null;
  modelReplacementError: string | null;
};
export function codexBindingForRole(role: string): Readonly<{ model: string; reasoningEffort: string }>;
