export const CodexWorkerRole: Readonly<{ Writer: "writer"; Operational: "operational"; Reviewer: "reviewer"; Verifier: "verifier";
  Explorer: "explorer"; Mechanical: "mechanical" }>;
export const VIBE_AGENT_ROLES: Readonly<Record<string, string>>;
export const ModelRuntime: Readonly<{ Claude: "claude"; Codex: "codex" }>;
export const ModelSource: Readonly<{ Launch: "launch"; Agent: "agent"; Role: "role"; Default: "default" }>;
export const MODELS_FILE_ENV: string;
export const MODEL_OVERRIDES_INVALID: string;
export type ModelOverrideOptions = { env?: Record<string, string | undefined>; home?: string };
export function isModelName(value: unknown): value is string;
export function agentRole(agentName: string): { agent: string; role: string };
export function modelsFile(options?: ModelOverrideOptions): string;
export function readModelOverrides(options?: ModelOverrideOptions): Record<string, unknown>;
export function resolveWorkerModel(runtime: string, agentName: string, defaultModel: string,
  options?: ModelOverrideOptions & { launchModel?: string }): { model: string; source: string };
export function resolveRoleModel(runtime: string, role: string, defaultModel: string,
  options?: ModelOverrideOptions & { launchModel?: string }): { model: string; source: string };
export function setModelOverride(runtime: string, key: string, model?: string, options?: ModelOverrideOptions): Record<string, unknown>;
