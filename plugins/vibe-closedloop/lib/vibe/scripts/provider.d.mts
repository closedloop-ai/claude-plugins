/** The binding a script in a session (or this conversation) reads, or null. */
export function sessionBinding(worktree?: string | null, env?: NodeJS.ProcessEnv): unknown;
/** The bound provider's `data[capability][key]`, or `fallback`. */
export function providerDataOr<T>(binding: unknown, capability: string, key: string, fallback: T): T;
/** The binding, with its contract, when it is bound with `capability` and its provider is still where it was bound; else null. */
export function boundWith(binding: unknown, capability: string): unknown;
/** The label of connection `name` that the provider bound with `capability` declares, or null. */
export function connectionLabel(binding: unknown, capability: string, name: string): string | null;
/** `text` with each provider stub replaced by its block when the binding has every capability it names, else its generic region kept; throws ProviderBroken when a claimed provider's text cannot be read. */
export function assembleProviderText(text: string, binding: unknown): string;
/** Whether `error` is a ProviderBroken, from this copy of the module or another. */
export function isProviderBroken(error: unknown): error is ProviderBroken;
/** A script's top-level exit code for `error`: 4 with the `provider-broken:` line for a ProviderBroken, else `fallback`. */
export function scriptExitCode(error: unknown, fallback: number): number;
/** Exits an uncaught ProviderBroken with 4 and its `provider-broken:` line. */
export function exitOnProviderBroken(): void;
export function failScript(error: unknown, fallback: number): number;
/** A session bound to a provider whose text cannot be read; its message names the reason and the fix. */
export class ProviderBroken extends Error {
  constructor(reason: string, name?: string | null, fix?: string | null);
}
/** The folder of vibe's own install that holds a provider built into it. */
export const BUNDLED_PROVIDER_DIR: string;
/** The contract's file name in a provider folder. */
export const CONTRACT_FILE: string;
/** A provider contract as provider.json declares it. */
export interface ProviderContract {
  vibeProvider: number;
  name: string;
  references: string;
  /** In a vibe release built with the provider: each whole reference file's path under `references`. */
  placed?: Record<string, string>;
  capabilities: Record<string, { needs: string[] }>;
  connections?: Record<string, { label: string; check: string }>;
  data?: Record<string, Record<string, unknown>>;
}
/** The provider built into vibe's install. */
export interface InstalledProvider { name: string; root: string; version: string | null; contract: ProviderContract }
/** The contract at a provider `root`, or null when it is not one vibe can speak to. */
export function readContract(root: string): ProviderContract | null;
/** The provider built into vibe's install, as a list of none or one, found from `from` (a file URL or path inside vibe or vibe-core). */
export function installedProviders(options?: { cwd?: string; from?: string }): InstalledProvider[];
/** The binding for a conversation in `cwd`. */
export function probeProvider(options?: { runtime?: string; cwd?: string; connections?: Record<string, string>; now?: Date;
  providers?: InstalledProvider[] }): { state: string; name?: string; version?: string | null; root?: string; capabilities?: string[]; reason?: string; [key: string]: unknown };
/** The absolute path of the bound provider's whole reference `file`. */
export function providerPath(binding: unknown, capability: string, file: string): string;
/** The block `id` of provider reference `file`, unchanged. */
export function providerBlock(binding: unknown, capability: string, file: string, id: string): string;
/** Every `> Provider` stub of `text`, in file order. */
export function providerStubs(text: string): { capability: string; id: string; file: string }[];
