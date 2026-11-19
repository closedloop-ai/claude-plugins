import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codexPluginFingerprint } from "./codex-plugin-fingerprint.js";
import {
  BUNDLE_PIN_FILE,
  bundleVersion,
  ENTRY_FILES,
  HOOK_COMMAND_STUBS,
  LOADER_FILE,
  readBundlePin,
  REPO_ROOT,
  STUB_FILES,
  THIN_FILES,
  THIN_LINE_BUDGET,
  toBundlePath,
  VIBE_CORE_DIR,
} from "./vibe-core-bundle.js";

const STATIC_IMPORT = /(?:^|[^\w.$])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|[^\w.$])import\s*["']([^"']+)["']/g;
const LITERAL_DYNAMIC_IMPORT = /(?:^|[^\w.$])import\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g;
const ANY_DYNAMIC_IMPORT = /(?:^|[^\w.$])import\s*\(/g;
const HOOK_COMMAND = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/;

/** Every entry under `dir`, as `{ path, kind }` relative to vibe-core, without following symlinks. */
function walk(dir: string, found: Array<{ path: string; kind: "file" | "directory" | "other" }> = []) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const stat = lstatSync(file);
    const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    found.push({ path: toBundlePath(file), kind });
    if (kind === "directory") walk(file, found);
  }
  return found;
}

function hookCommandFiles(): string[] {
  const config = JSON.parse(readFileSync(join(VIBE_CORE_DIR, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  return Object.values(config.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => {
    const match = HOOK_COMMAND.exec(hook.command);
    if (!match?.[1]) throw new Error(`unexpected hook command: ${hook.command}`);
    return match[1];
  })));
}

/** The static import closure of `entries`: every module reached, every specifier that is not a relative module, and each module's computed dynamic imports. */
function importClosure(entries: string[]) {
  const modules = new Set<string>();
  const external: string[] = [];
  const computed: string[] = [];
  const pending = [...entries];
  for (let module = pending.pop(); module !== undefined; module = pending.pop()) {
    if (modules.has(module)) continue;
    modules.add(module);
    const source = readFileSync(join(VIBE_CORE_DIR, module), "utf8");
    const specifiers = [...source.matchAll(STATIC_IMPORT)].map((match) => match[1] ?? match[2] ?? "")
      .concat([...source.matchAll(LITERAL_DYNAMIC_IMPORT)].map((match) => match[1] ?? ""));
    const dynamic = [...source.matchAll(ANY_DYNAMIC_IMPORT)].length - [...source.matchAll(LITERAL_DYNAMIC_IMPORT)].length;
    for (let index = 0; index < dynamic; index += 1) computed.push(module);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) pending.push(toBundlePath(resolve(dirname(join(VIBE_CORE_DIR, module)), specifier)));
      else external.push(`${module} imports ${specifier}`);
    }
  }
  return { modules: [...modules].sort(), external, computed };
}

describe("vibe-core bundle", () => {
  it("holds exactly the loader and the frozen stubs", () => {
    const files = walk(VIBE_CORE_DIR).filter((entry) => entry.kind !== "directory").map((entry) => entry.path).sort();
    expect(files, "plugins/vibe-core holds a file outside the allowlist in tools/plugin-manifests/src/vibe-core-bundle.ts: "
      + "move guard code, tests and helpers into plugins/vibe, which Codex does not ask anyone to re-approve")
      .toEqual([...THIN_FILES, ...STUB_FILES].sort());
  });

  it("runs only the loader from its hook commands: node builtins, one computed import of vibe's runtime, no child processes", () => {
    const commands = hookCommandFiles();
    expect([...new Set(commands)].sort()).toEqual([...ENTRY_FILES].sort());
    const { modules, external, computed } = importClosure(commands);
    expect(modules.filter((module) => !THIN_FILES.includes(module)), "a hook command reaches a module outside the thin set").toEqual([]);
    expect(external.filter((line) => !/ imports node:[a-z_/]+$/.test(line)), "a hook module imports something that is not a node: builtin").toEqual([]);
    expect(external.filter((line) => line.endsWith("node:child_process")), "a hook module starts child processes").toEqual([]);
    expect(computed, "only hooks/vibe-runtime.mjs may import a computed path, once (vibe's hooks/runtime.mjs)").toEqual([LOADER_FILE]);
    for (const module of modules) {
      expect(readFileSync(join(VIBE_CORE_DIR, module), "utf8"), `${module} mentions child_process`).not.toMatch(/child_process/);
    }
  });

  it(`keeps the thin set under ${THIN_LINE_BUDGET} lines`, () => {
    const lines = THIN_FILES.reduce((total, file) => total + readFileSync(join(VIBE_CORE_DIR, file), "utf8").split("\n").length - 1, 0);
    expect(lines).toBeLessThan(THIN_LINE_BUDGET);
  });

  // codexPluginFingerprint reproduces the trusted_content_hash codex-cli 0.169.0 recorded for vibe-core 1.0.13 and
  // code 2.0.2 (see codex-plugin-fingerprint.ts), so this pin is the value Codex users approve.
  it("matches the pinned Codex fingerprint", () => {
    const actual = { version: bundleVersion(), fingerprint: codexPluginFingerprint(VIBE_CORE_DIR) };
    if (process.env.PIN_VIBE_CORE_BUNDLE === "1") writeFileSync(BUNDLE_PIN_FILE, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual, "plugins/vibe-core changed, so every Codex user must approve vibe-core's hooks again. Move the change into plugins/vibe "
      + "if it can live there; otherwise bump vibe-core's version in both manifests and re-pin in the same change with "
      + "`npm run pin:vibe-core-bundle` in tools/plugin-manifests").toEqual(readBundlePin());
  });

  it("never lets vibe register its own hooks, and holds no symlinks", () => {
    expect(existsSync(join(REPO_ROOT, "plugins", "vibe", "hooks", "hooks.json")),
      "plugins/vibe/hooks/hooks.json would make every vibe-core stand down and Claude Code register vibe's hooks itself").toBe(false);
    expect(walk(VIBE_CORE_DIR).filter((entry) => entry.kind === "other").map((entry) => entry.path),
      "Codex cannot fingerprint a symlink and skips every hook of the plugin").toEqual([]);
  });

  it("keeps every module stub byte-identical, and each hook-command stub one exit code apart from them", () => {
    const [first, ...rest] = STUB_FILES.filter((file) => !HOOK_COMMAND_STUBS.includes(file)).map((file) => readFileSync(join(VIBE_CORE_DIR, file), "utf8"));
    expect(rest.filter((source) => source !== first)).toEqual([]);
    for (const file of HOOK_COMMAND_STUBS) {
      expect(STUB_FILES).toContain(file);
      const body = (source: string) => source.split("\n").filter((line) => !line.startsWith("//")).join("\n");
      expect(body(readFileSync(join(VIBE_CORE_DIR, file), "utf8")), file).toBe(body(first ?? "").replace("process.exit(1);", "process.exit(0);"));
    }
  });
});
