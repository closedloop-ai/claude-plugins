/**
 * Contract checks for the erd-diagram skill text and payload, so the rules the user set
 * for it (code only, update in place, stop on a missing path, two styles) cannot drift.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STYLES } from "./lib/erd.js";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins/closedloop-core/skills/erd-diagram");
const skill = readFileSync(join(SKILL_ROOT, "SKILL.md"), "utf8");

describe("erd-diagram skill contract", () => {
  it("declares its name and both styles as arguments", () => {
    expect(skill).toMatch(/^---\nname: erd-diagram\n/);
    expect(skill).toContain('argument-hint: "[canvas-sidebar|schema-explorer] [path/to/existing-erd.html]"');
    for (const style of STYLES) expect(skill).toContain(`\`${style}\``);
  });

  it("forbids touching any database", () => {
    expect(skill).toContain("**Code only.** Never connect to, query, or test against any database");
  });

  it("stops on a missing path and updates an existing one", () => {
    expect(skill).toContain("**Path given, file missing**: stop.");
    expect(skill).toContain("**Path given, file exists**: update mode");
    expect(skill).toContain("**No path**: new-diagram mode");
  });

  it("points at payload files that exist", () => {
    for (const rel of ["scripts/dist/erd.mjs", "scripts/dist/verify.mjs", "references/model-format.md"]) {
      expect(skill).toContain(rel.replace(/^references\//, "./references/"));
      expect(existsSync(join(SKILL_ROOT, rel)), rel).toBe(true);
    }
  });

  it("ships a template for every style with every placeholder", () => {
    for (const style of STYLES) {
      const html = readFileSync(join(SKILL_ROOT, "templates", `${style}.html`), "utf8");
      for (const key of ["TITLE", "META", "SCHEMA", "LAYOUT"]) expect(html, `${style} ${key}`).toContain(`__${key}__`);
    }
    const canvas = readFileSync(join(SKILL_ROOT, "templates", "canvas-sidebar.html"), "utf8");
    for (const key of ["DOMAINS", "HUBS"]) expect(canvas).toContain(`__${key}__`);
  });
});
