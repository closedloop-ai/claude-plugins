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
