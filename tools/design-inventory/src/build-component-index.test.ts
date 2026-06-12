/** Tests for build-component-index.ts */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildIndex, main } from "./build-component-index.js";

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const CARD_STORY = `\
import type { Meta, StoryObj } from "@storybook/react";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { BellRing } from "lucide-react";

const meta: Meta<typeof Card> = { component: Card };
export default meta;
`;

const CARD_SOURCE = `\
import React from "react";
import { cva } from "class-variance-authority";

interface CardProps {
  title?: string;
  onClose: () => void;
}

interface CardContentProps {
  children?: React.ReactNode;
}

const cardVariants = cva("base", {
  variants: {
    size: {
      sm: "text-sm",
      lg: "text-lg",
    },
    tone: {
      quiet: "opacity-50",
    },
  },
});

export { Card, CardContent };
`;

const NODE_MODULES_STORY = `\
import { BadActor } from "@repo/design-system/components/ui/bad";

export default {};
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(base: string): string {
  const storyPath = join(base, "apps", "storybook", "stories", "card.stories.tsx");
  mkdirSync(join(base, "apps", "storybook", "stories"), { recursive: true });
  writeFileSync(storyPath, CARD_STORY, "utf-8");

  const sourcePath = join(
    base,
    "packages",
    "design-system",
    "components",
    "ui",
    "card.tsx",
  );
  mkdirSync(join(base, "packages", "design-system", "components", "ui"), { recursive: true });
  writeFileSync(sourcePath, CARD_SOURCE, "utf-8");

  // node_modules story that must be excluded
  const nmStory = join(base, "node_modules", "x", "y.stories.tsx");
  mkdirSync(join(base, "node_modules", "x"), { recursive: true });
  writeFileSync(nmStory, NODE_MODULES_STORY, "utf-8");

  return base;
}

interface AnyEntry {
  component: string;
  import_path: string;
  story: string;
  source_path?: string;
  props?: string[];
  variants?: string[];
}

function indexByComponent(
  components: AnyEntry[],
): Record<string, AnyEntry> {
  const result: Record<string, AnyEntry> = {};
  for (const c of components) {
    result[c.component] = c;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests: component presence / absence
// ---------------------------------------------------------------------------

describe("TestImportExtraction", () => {
  it("Card is present", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const components = buildIndex(repo);
    const names = new Set(components.map((c) => c.component));
    expect(names.has("Card")).toBe(true);
  });

  it("CardContent is present", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const components = buildIndex(repo);
    const names = new Set(components.map((c) => c.component));
    expect(names.has("CardContent")).toBe(true);
  });

  it("BellRing is present", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const components = buildIndex(repo);
    const names = new Set(components.map((c) => c.component));
    expect(names.has("BellRing")).toBe(true);
  });

  it("Meta is absent", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const components = buildIndex(repo);
    const names = new Set(components.map((c) => c.component));
    expect(names.has("Meta")).toBe(false);
  });

  it("StoryObj is absent", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const components = buildIndex(repo);
    const names = new Set(components.map((c) => c.component));
    expect(names.has("StoryObj")).toBe(false);
  });

  it("node_modules story is excluded (BadActor absent)", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const components = buildIndex(repo);
    const names = new Set(components.map((c) => c.component));
    expect(names.has("BadActor")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: enrichment
// ---------------------------------------------------------------------------

describe("TestEnrichment", () => {
  it("Card source_path ends with card.tsx", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const byName = indexByComponent(buildIndex(repo));
    const card = byName["Card"]!;
    expect(card.source_path).toBeDefined();
    expect(String(card.source_path)).toMatch(/card\.tsx$/);
  });

  it("Card props contains title and onClose", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const byName = indexByComponent(buildIndex(repo));
    const card = byName["Card"]!;
    expect(card.props).toBeDefined();
    expect(card.props as string[]).toContain("title");
    expect(card.props as string[]).toContain("onClose");
  });

  it("Card variants contains size and tone", () => {
    const repo = makeRepo(mkdtempSync(join(tmpdir(), "ci-")));
    const byName = indexByComponent(buildIndex(repo));
    const card = byName["Card"]!;
    expect(card.variants).toBeDefined();
    expect(card.variants as string[]).toContain("size");
    expect(card.variants as string[]).toContain("tone");
  });

  it("CardContent has no props key when CardContentProps interface is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "ci-"));
    const repo = makeRepo(base);

    // Remove CardContentProps interface from source to match spec
    const sourcePath = join(
      base,
      "packages",
      "design-system",
      "components",
      "ui",
      "card.tsx",
    );
    const sourceText = readFileSync(sourcePath, "utf-8");
    const cleaned = sourceText.replace(
      "\ninterface CardContentProps {\n  children?: React.ReactNode;\n}\n",
      "\n",
    );
    writeFileSync(sourcePath, cleaned, "utf-8");

    const byName = indexByComponent(buildIndex(repo));
    const cardContent = byName["CardContent"]!;
    expect(cardContent.props).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: CLI
// ---------------------------------------------------------------------------

describe("TestCli", () => {
  it("returns 1 and prints usage when --out is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "ci-"));
    const repo = makeRepo(base);
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    const rc = main([repo]);
    process.stderr.write = origWrite;
    expect(rc).toBe(1);
    expect(stderrChunks.join("")).toContain("--out");
  });

  it("writes --out file, returns 0, prints output path", () => {
    const base = mkdtempSync(join(tmpdir(), "ci-"));
    const repo = makeRepo(base);
    const expected = join(mkdtempSync(join(tmpdir(), "out-")), "component-index.json");

    // Capture stdout
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    const rc = main([repo, "--out", expected]);
    process.stdout.write = origWrite;

    expect(rc).toBe(0);
    expect(written.join("").trim()).toBe(expected);
    const data = JSON.parse(readFileSync(expected, "utf-8")) as {
      commit: unknown;
      components: unknown[];
    };
    expect(data).toHaveProperty("commit");
    expect(data).toHaveProperty("components");
    expect(Array.isArray(data.components)).toBe(true);
  });

  it("returns 1 on nonexistent repo", () => {
    const base = mkdtempSync(join(tmpdir(), "ci-"));
    const out = join(mkdtempSync(join(tmpdir(), "out-")), "component-index.json");
    expect(main([join(base, "does-not-exist"), "--out", out])).toBe(1);
  });

  it("respects --out custom path", () => {
    const base = mkdtempSync(join(tmpdir(), "ci-"));
    const repo = makeRepo(base);
    const out = join(mkdtempSync(join(tmpdir(), "out-")), "custom", "out.json");
    const rc = main([repo, "--out", out]);
    expect(rc).toBe(0);
    const data = JSON.parse(readFileSync(out, "utf-8")) as { components: unknown };
    expect(data).toHaveProperty("components");
  });
});
