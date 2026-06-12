/** Tests for build-route-map.ts */

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildRouteMap,
  deriveAppRoute,
  deriveLayoutPrefix,
  derivePagesRoute,
  extractComponents,
  isExcluded,
  main,
} from "./build-route-map.js";

// ---------------------------------------------------------------------------
// Sample source content used across tests
// ---------------------------------------------------------------------------

const SESSIONS_PAGE_TSX = `\
import { Card, Badge } from "@repo/design-system/components/ui/card";
import SessionTable from "@repo/x";
import { useEffect } from "react";
import Link from "next/link";

export default function SessionsPage() {
    return <Card><SessionTable /></Card>;
}
`;

const AUTH_LAYOUT_TSX = `\
import { Sidebar } from "@repo/ui";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return <div><Sidebar />{children}</div>;
}
`;

const ROOT_PAGE_TSX = `\
export default function HomePage() {
    return <h1>Home</h1>;
}
`;

const LEGACY_ABOUT_TSX = `\
import { PageHeader } from "@repo/ui";

export default function About() {
    return <PageHeader>About</PageHeader>;
}
`;

const LEGACY_API_X_TS = `\
export default function handler(req: any, res: any) {
    res.json({ ok: true });
}
`;

const JUNK_PAGE_TSX = `\
import { Secret } from "@junk/lib";
export default function JunkPage() { return null; }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function write(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
}

function makeRepo(base: string): void {
  // App-router pages
  write(
    join(base, "apps", "web", "app", "(auth)", "[orgSlug]", "sessions", "page.tsx"),
    SESSIONS_PAGE_TSX,
  );
  // App-router layout under (auth)
  write(join(base, "apps", "web", "app", "(auth)", "layout.tsx"), AUTH_LAYOUT_TSX);
  // Root page
  write(join(base, "apps", "web", "app", "page.tsx"), ROOT_PAGE_TSX);

  // Pages-router
  write(join(base, "apps", "web", "pages", "legacy", "about.tsx"), LEGACY_ABOUT_TSX);
  write(join(base, "apps", "web", "pages", "api", "x.ts"), LEGACY_API_X_TS);

  // Must be excluded: inside node_modules
  write(join(base, "node_modules", "junk", "app", "foo", "page.tsx"), JUNK_PAGE_TSX);
}

function tmpRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "route-map-test-"));
  makeRepo(base);
  return base;
}

function initGitRepo(repoPath: string): string {
  execFileSync("git", ["init", repoPath], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@test.com"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "add", "."], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", repoPath, "commit", "--no-gpg-sign", "-m", "init"],
    { stdio: "ignore" },
  );
  const sha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  return sha;
}

// ---------------------------------------------------------------------------
// Unit tests: isExcluded
// ---------------------------------------------------------------------------

describe("isExcluded", () => {
  it("excludes node_modules", () => {
    const base = mkdtempSync(join(tmpdir(), "excl-"));
    expect(isExcluded(join(base, "node_modules", "junk", "page.tsx"), base)).toBe(true);
  });

  it("excludes dist", () => {
    const base = mkdtempSync(join(tmpdir(), "excl-"));
    expect(isExcluded(join(base, "dist", "page.tsx"), base)).toBe(true);
  });

  it("excludes .next", () => {
    const base = mkdtempSync(join(tmpdir(), "excl-"));
    expect(isExcluded(join(base, ".next", "server", "page.tsx"), base)).toBe(true);
  });

  it("excludes .turbo", () => {
    const base = mkdtempSync(join(tmpdir(), "excl-"));
    expect(isExcluded(join(base, ".turbo", "cache", "page.tsx"), base)).toBe(true);
  });

  it("does not exclude normal paths", () => {
    const base = mkdtempSync(join(tmpdir(), "excl-"));
    expect(isExcluded(join(base, "apps", "web", "app", "page.tsx"), base)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: deriveAppRoute
// ---------------------------------------------------------------------------

describe("deriveAppRoute", () => {
  it("keeps dynamic segment, drops route group", () => {
    const base = mkdtempSync(join(tmpdir(), "route-"));
    const page = join(base, "app", "(auth)", "[orgSlug]", "sessions", "page.tsx");
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, "");
    expect(deriveAppRoute(page)).toBe("/[orgSlug]/sessions");
  });

  it("returns / for root page", () => {
    const base = mkdtempSync(join(tmpdir(), "route-"));
    const page = join(base, "app", "page.tsx");
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, "");
    expect(deriveAppRoute(page)).toBe("/");
  });

  it("returns /dashboard for plain segment", () => {
    const base = mkdtempSync(join(tmpdir(), "route-"));
    const page = join(base, "app", "dashboard", "page.tsx");
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, "");
    expect(deriveAppRoute(page)).toBe("/dashboard");
  });

  it("drops all groups", () => {
    const base = mkdtempSync(join(tmpdir(), "route-"));
    const page = join(base, "app", "(group1)", "(group2)", "page.tsx");
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, "");
    expect(deriveAppRoute(page)).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: deriveLayoutPrefix
// ---------------------------------------------------------------------------

describe("deriveLayoutPrefix", () => {
  it("(auth)/layout.tsx becomes /", () => {
    const base = mkdtempSync(join(tmpdir(), "layout-"));
    const layout = join(base, "app", "(auth)", "layout.tsx");
    mkdirSync(dirname(layout), { recursive: true });
    writeFileSync(layout, "");
    expect(deriveLayoutPrefix(layout)).toBe("/");
  });

  it("dashboard/layout.tsx becomes /dashboard", () => {
    const base = mkdtempSync(join(tmpdir(), "layout-"));
    const layout = join(base, "app", "dashboard", "layout.tsx");
    mkdirSync(dirname(layout), { recursive: true });
    writeFileSync(layout, "");
    expect(deriveLayoutPrefix(layout)).toBe("/dashboard");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: derivePagesRoute
// ---------------------------------------------------------------------------

describe("derivePagesRoute", () => {
  it("about.tsx -> /legacy/about", () => {
    const base = mkdtempSync(join(tmpdir(), "pages-"));
    const about = join(base, "pages", "legacy", "about.tsx");
    mkdirSync(dirname(about), { recursive: true });
    writeFileSync(about, "");
    expect(derivePagesRoute(about)).toBe("/legacy/about");
  });

  it("index.tsx -> /", () => {
    const base = mkdtempSync(join(tmpdir(), "pages-"));
    const index = join(base, "pages", "index.tsx");
    mkdirSync(dirname(index), { recursive: true });
    writeFileSync(index, "");
    expect(derivePagesRoute(index)).toBe("/");
  });

  it("settings/index.tsx -> /settings", () => {
    const base = mkdtempSync(join(tmpdir(), "pages-"));
    const index = join(base, "pages", "settings", "index.tsx");
    mkdirSync(dirname(index), { recursive: true });
    writeFileSync(index, "");
    expect(derivePagesRoute(index)).toBe("/settings");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: extractComponents
// ---------------------------------------------------------------------------

describe("extractComponents", () => {
  it("extracts named imports", () => {
    const text = 'import { Card, Badge } from "@repo/ui";';
    const result = extractComponents(text);
    expect(result).toContain("Card");
    expect(result).toContain("Badge");
  });

  it("extracts default import", () => {
    const text = 'import SessionTable from "@repo/x";';
    expect(extractComponents(text)).toContain("SessionTable");
  });

  it("skips lowercase names", () => {
    const text = 'import { useEffect } from "react";';
    expect(extractComponents(text)).not.toContain("useEffect");
  });

  it("skips next/ modules", () => {
    const text = 'import Link from "next/link";';
    expect(extractComponents(text)).not.toContain("Link");
  });

  it("skips react modules", () => {
    const text = 'import React from "react";';
    expect(extractComponents(text)).not.toContain("React");
  });

  it("uses original name before alias", () => {
    const text = 'import { Card as MyCard } from "@repo/ui";';
    const result = extractComponents(text);
    expect(result).toContain("Card");
    expect(result).not.toContain("MyCard");
  });

  it("handles sessions page content", () => {
    const result = extractComponents(SESSIONS_PAGE_TSX);
    expect(result).toContain("Card");
    expect(result).toContain("Badge");
    expect(result).toContain("SessionTable");
    expect(result).not.toContain("Link");
  });

  it("caps at 20", () => {
    const names = Array.from({ length: 30 }, (_, i) => `Comp${i}`).join(", ");
    const text = `import { ${names} } from "@repo/ui";`;
    const result = extractComponents(text);
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: buildRouteMap
// ---------------------------------------------------------------------------

describe("buildRouteMap", () => {
  it("has exactly the expected route keys", () => {
    const repo = tmpRepo();
    const result = buildRouteMap(repo);
    expect(new Set(Object.keys(result.routes))).toEqual(
      new Set(["/", "/[orgSlug]/sessions", "/legacy/about"]),
    );
  });

  it("sessions route has correct components", () => {
    const repo = tmpRepo();
    const result = buildRouteMap(repo);
    const sessions = result.routes["/[orgSlug]/sessions"]!;
    expect(sessions.shared_components).toContain("Card");
    expect(sessions.shared_components).toContain("Badge");
    expect(sessions.shared_components).toContain("SessionTable");
  });

  it("sessions route has a repo-relative POSIX path", () => {
    const repo = tmpRepo();
    const result = buildRouteMap(repo);
    const sessions = result.routes["/[orgSlug]/sessions"]!;
    expect(sessions.paths).toHaveLength(1);
    expect(sessions.paths[0]).toMatch(/sessions\/page\.tsx$/);
    expect(sessions.paths[0]).not.toMatch(/node_modules/);
    expect(sessions.paths[0]).not.toMatch(/^\//);
    expect(sessions.paths[0]).not.toContain("\\");
  });

  it("node_modules are excluded from all paths", () => {
    const repo = tmpRepo();
    const result = buildRouteMap(repo);
    for (const entry of Object.values(result.routes)) {
      for (const p of entry.paths) {
        expect(p).not.toContain("node_modules");
      }
    }
  });

  it("api routes are excluded", () => {
    const repo = tmpRepo();
    const result = buildRouteMap(repo);
    expect(result.routes["/api/x"]).toBeUndefined();
    expect(result.routes["/api"]).toBeUndefined();
  });

  it("chrome contains auth layout at /", () => {
    const repo = tmpRepo();
    const result = buildRouteMap(repo);
    expect(result.chrome["/"]).toBeDefined();
    const auth = result.chrome["/"]!;
    expect(auth.paths.some((p) => p.includes("layout.tsx"))).toBe(true);
    expect(auth.shared_components).toContain("Sidebar");
  });

  it("commit is null without a git repo", () => {
    const repo = tmpRepo();
    expect(buildRouteMap(repo).commit).toBeNull();
  });

  it("commit matches HEAD SHA when git is initialized", () => {
    const repo = tmpRepo();
    const sha = initGitRepo(repo);
    expect(buildRouteMap(repo).commit).toBe(sha);
  });

  it("root route is present", () => {
    const repo = tmpRepo();
    expect(buildRouteMap(repo).routes["/"]).toBeDefined();
  });

  it("legacy/about route is present with about.tsx path", () => {
    const repo = tmpRepo();
    const result = buildRouteMap(repo);
    expect(result.routes["/legacy/about"]).toBeDefined();
    expect(result.routes["/legacy/about"]!.paths.some((p) => p.includes("about.tsx"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: main() CLI
// ---------------------------------------------------------------------------

describe("main (CLI)", () => {
  it("returns 1 and prints usage when --out is absent", () => {
    const repo = tmpRepo();
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

  it("returns 0 and writes the --out file", () => {
    const repo = tmpRepo();
    const out = join(mkdtempSync(join(tmpdir(), "out-")), "route-map.json");
    expect(main([repo, "--out", out])).toBe(0);
    expect(() => readFileSync(out)).not.toThrow();
  });

  it("written JSON is valid with routes/chrome/commit keys", () => {
    const repo = tmpRepo();
    const out = join(mkdtempSync(join(tmpdir(), "out-")), "route-map.json");
    main([repo, "--out", out]);
    const data = JSON.parse(readFileSync(out, "utf-8")) as Record<string, unknown>;
    expect(data).toHaveProperty("routes");
    expect(data).toHaveProperty("chrome");
    expect(data).toHaveProperty("commit");
  });

  it("respects --out custom path", () => {
    const repo = tmpRepo();
    const custom = join(mkdtempSync(join(tmpdir(), "out-")), "custom", "out.json");
    expect(main([repo, "--out", custom])).toBe(0);
    expect(() => readFileSync(custom)).not.toThrow();
  });

  it("returns 1 for nonexistent repo", () => {
    const base = mkdtempSync(join(tmpdir(), "missing-"));
    const out = join(mkdtempSync(join(tmpdir(), "out-")), "route-map.json");
    expect(main([join(base, "does-not-exist"), "--out", out])).toBe(1);
  });

  it("returns 1 for a file instead of directory", () => {
    const base = mkdtempSync(join(tmpdir(), "file-"));
    const f = join(base, "file.txt");
    writeFileSync(f, "hello");
    const out = join(mkdtempSync(join(tmpdir(), "out-")), "route-map.json");
    expect(main([f, "--out", out])).toBe(1);
  });

  it("output paths are POSIX-relative (no backslashes, not absolute)", () => {
    const repo = tmpRepo();
    const out = join(mkdtempSync(join(tmpdir(), "out-")), "route-map.json");
    main([repo, "--out", out]);
    const data = JSON.parse(readFileSync(out, "utf-8")) as {
      routes: Record<string, { paths: string[] }>;
    };
    for (const entry of Object.values(data.routes)) {
      for (const p of entry.paths) {
        expect(p).not.toContain("\\");
        expect(p).not.toMatch(/^\//);
      }
    }
  });
});
