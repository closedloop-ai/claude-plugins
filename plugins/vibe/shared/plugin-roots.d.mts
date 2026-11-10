export declare const MANIFESTS: readonly string[];
export declare const Layout: Readonly<{ Checkout: "checkout"; Claude: "claude"; Codex: "codex" }>;
export declare function pluginManifest(root: string): { name: string; version: string | null } | null;
export declare function ownPluginRoot(from: string): { root: string; name: string; version: string | null };
export declare function comparePluginVersions(left: string, right: string): number;
export declare function activeCodexVersion(versions: string[]): string | null;
export declare function siblingPluginRoot(name: string, options: { from: string }): string;
export declare function siblingPluginRootOrNull(name: string, options: { from: string }): string | null;
