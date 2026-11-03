import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./cli.js";
import { safeJson } from "./erd.js";

const TEMPLATES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../plugins/closedloop-core/skills/erd-diagram/templates",
);

const PRISMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// Holds </script> and <!-- so the page must escape it. Ünïcode too.
model User {
  id    String @id
  posts Post[]
}

model Post {
  id       String @id
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
}
`;

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

function write(rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, TEMPLATES, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function embedded(path: string, id: string): unknown {
  const m = new RegExp(`<script id="${id}" type="application/json">(.*?)</script>`, "s").exec(readFileSync(path, "utf8"));
  return m ? JSON.parse(m[1] ?? "null") : null;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "erd-cli-"));
  git("init", "-q");
  git("config", "user.email", "erd@example.com");
  git("config", "user.name", "erd test");
  write("prisma/schema.prisma", PRISMA);
  write("desktop/local.prisma", 'datasource db {\n  provider = "sqlite"\n}\nmodel Cache {\n  id Int @id\n}\n');
  write("test/fixtures/schema.sql", "CREATE TABLE ignored (id int);");
  git("add", ".");
  git("commit", "-qm", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("safeJson", () => {
  it("cannot close or comment out its script block and stays ASCII", () => {
    const text = safeJson({ a: "</script><!-- é  " });
    expect(text).toBe('{"a":"<\\u002fscript><\\u0021-- \\u00e9 \\u2028"}');
    expect(JSON.parse(text)).toEqual({ a: "</script><!-- é  " });
  });
});

describe("detect", () => {
  it("lists schema sources with their database and skips test fixtures", async () => {
    const { code, out } = await cli("detect", "--repo", repo);
    expect(code).toBe(0);
    const sources = JSON.parse(out).sources as Array<{ spec: string; database: string }>;
    expect(sources.map((s) => [s.spec, s.database])).toEqual([
      ["prisma:desktop/local.prisma", "sqlite"],
      ["prisma:prisma/schema.prisma", "postgres"],
    ]);
  });
});

describe("build, inspect and update", () => {
  it("builds both styles from the Postgres source and refuses to overwrite", async () => {
    for (const style of ["canvas-sidebar", "schema-explorer"]) {
      const out = join(repo, `${style}.html`);
      const built = await cli("build", "--style", style, "--out", out, "--repo", repo);
      expect(built.code, built.err).toBe(0);
      expect(JSON.parse(built.out)).toMatchObject({ style, source: "prisma:prisma/schema.prisma", tables: 2, relations: 1 });
      const html = readFileSync(out, "utf8");
      expect(html).not.toMatch(/__(TITLE|META|SCHEMA|LAYOUT|DOMAINS|HUBS)__/);
      expect(html).not.toContain("Holds </script>");
      expect(embedded(out, "erd-meta")).toMatchObject({ generator: "erd-diagram", style, source: { kind: "prisma" } });
      const schema = embedded(out, "schema-data") as { models: Array<{ name: string; doc: string }> };
      expect(schema.models.find((m) => m.name === "User")?.doc).toContain("</script> and <!--");

      const again = await cli("build", "--style", style, "--out", out, "--repo", repo);
      expect(again.code).toBe(3);
    }
  });

  it("updates in place, reports new and removed tables, and converts style", async () => {
    const out = join(repo, "erd.html");
    expect((await cli("build", "--style", "canvas-sidebar", "--out", out, "--repo", repo)).code).toBe(0);

    write("prisma/schema.prisma", PRISMA.replace("model Post {", "model Comment {\n  id String @id\n}\n\nmodel Post {"));
    const updated = await cli("update", out, "--style", "schema-explorer");
    expect(updated.code, updated.err).toBe(0);
    expect(JSON.parse(updated.out)).toMatchObject({
      style: "schema-explorer",
      previousStyle: "canvas-sidebar",
      newTables: ["Comment"],
      removedTables: [],
      commit: expect.stringContaining("+ local changes"),
    });
    const info = JSON.parse((await cli("inspect", out)).out);
    expect(info).toMatchObject({ legacy: false, style: "schema-explorer", domains: [{ id: "all", tables: 2 }] });
    expect(embedded(out, "layout-data")).toMatchObject({ domains: expect.arrayContaining([expect.objectContaining({ id: "unsorted", tables: ["Comment"] })]) });
  });

  it("stops without writing when the update target does not exist", async () => {
    const missing = join(repo, "nope.html");
    const res = await cli("update", missing);
    expect(res.code).toBe(2);
    expect(res.err).toContain("does not exist. Check the path for a typo; nothing was changed.");
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects an unknown style and a domain map naming unknown tables", async () => {
    expect((await cli("build", "--style", "poster", "--out", join(repo, "x.html"))).code).toBe(2);
    write("domains.json", JSON.stringify([{ id: "one", name: "One", tables: ["User", "Ghost"] }]));
    const res = await cli(
      "build",
      "--style",
      "canvas-sidebar",
      "--out",
      join(repo, "x.html"),
      "--repo",
      repo,
      "--domains",
      join(repo, "domains.json"),
    );
    expect(res.code).toBe(1);
    expect(res.err).toContain('domain "one" lists "Ghost", which is not a table in the schema');
    expect(existsSync(join(repo, "x.html"))).toBe(false);
  });
});
