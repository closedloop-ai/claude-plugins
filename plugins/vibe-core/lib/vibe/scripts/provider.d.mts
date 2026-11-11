/** The binding a script in a session (or this conversation) reads, or null. */
export function sessionBinding(worktree?: string | null, env?: NodeJS.ProcessEnv): unknown;
/** The bound provider's `data[capability][key]`, or `fallback`. */
export function providerDataOr<T>(binding: unknown, capability: string, key: string, fallback: T): T;
/** The binding, with its contract, when it is bound with `capability` and its provider is still where it was bound; else null. */
export function boundWith(binding: unknown, capability: string): unknown;
/** The label of connection `name` that the provider bound with `capability` declares, or null. */
export function connectionLabel(binding: unknown, capability: string, name: string): string | null;
/** `text` with each provider stub replaced by its block when the binding has every capability it names, else its generic region kept. */
export function assembleProviderText(text: string, binding: unknown): string;
