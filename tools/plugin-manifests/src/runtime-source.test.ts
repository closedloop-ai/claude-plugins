import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { unapprovedRuntimeSources } from "./runtime-source.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let temp: string | null = null;
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = null; });

it("flags a new hand-authored plugin runtime while allowing tests and built payloads", () => {
  temp = mkdtempSync(join(tmpdir(), "plugin-runtime-"));
  const root = temp;
  for (const file of ["plugins/vibe/scripts/new.mjs", "plugins/vibe/scripts/new.test.mjs",
    "plugins/vibe/skills/vibe/scripts/dist/generated.mjs", "plugins/vibe/scripts/dist/rogue.mjs"]) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "export {};");
  }
  expect(unapprovedRuntimeSources(root, new Set())).toEqual([
    "plugins/vibe/scripts/dist/rogue.mjs", "plugins/vibe/scripts/new.mjs",
  ]);
});

it("keeps the checked-in plugin tree on its legacy runtime inventory", () => {
  const allowed = new Set<string>(JSON.parse(readFileSync(join(REPO, "tools/plugin-manifests/legacy-runtime-mjs.json"), "utf8")));
  expect(unapprovedRuntimeSources(REPO, allowed)).toEqual([]);
});
