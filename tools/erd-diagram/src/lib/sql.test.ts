import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErdModel } from "./model.js";
import { extractSql, splitStatements } from "./sql.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "erd-sql-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, text: string): string {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function table(model: ErdModel, name: string) {
  const t = model.models.find((m) => m.name === name);
  if (!t) throw new Error(`no table ${name}`);
  return t;
}

function field(model: ErdModel, tableName: string, name: string) {
  const f = table(model, tableName).fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${tableName}.${name}`);
  return f;
}

describe("splitStatements", () => {
  it("splits on top-level semicolons only", () => {
    const sql = [
      "-- a comment; with a semicolon",
      "CREATE TABLE a (note text DEFAULT 'x;y');",
      "/* block; comment */ CREATE TABLE \"b;c\" (id int);",
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;",
      "CREATE TABLE d (id int)",
    ].join("\n");
    expect(splitStatements(sql)).toEqual([
      "CREATE TABLE a (note text DEFAULT 'x;y')",
      'CREATE TABLE "b;c" (id int)',
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
      "CREATE TABLE d (id int)",
    ]);
  });
});

describe("extractSql on a schema dump", () => {
  it("reads columns, keys, defaults, comments and enums", () => {
    const path = write(
      "structure.sql",
      `
CREATE TYPE public.user_role AS ENUM ('admin', 'member');
CREATE TABLE public.users (
  id bigint NOT NULL,
  email character varying(255) NOT NULL,
  role public.user_role DEFAULT 'member'::public.user_role NOT NULL,
  tags text[],
  created_at timestamp(6) with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.posts (
  id bigserial PRIMARY KEY,
  author_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  editor_id bigint,
  body text
);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.posts ADD CONSTRAINT posts_editor_fk FOREIGN KEY (editor_id) REFERENCES public.users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX index_users_on_email ON public.users USING btree (email);
CREATE UNIQUE INDEX index_posts_on_body ON public.posts USING btree (body) WHERE body IS NOT NULL;
CREATE TABLE public.schema_migrations (version character varying NOT NULL);
COMMENT ON TABLE public.users IS 'People who can sign in.';
COMMENT ON COLUMN public.users.email IS 'Login address; it''s unique.';
`,
    );
    const model = extractSql(path);
    expect(model.models.map((m) => m.name)).toEqual(["posts", "users"]);
    expect(table(model, "users").doc).toBe("People who can sign in.");
    expect(field(model, "users", "email")).toMatchObject({
      type: "varchar(255)",
      optional: false,
      uk: true,
      doc: "Login address; it's unique.",
    });
    expect(field(model, "users", "role")).toMatchObject({ kind: "enum", type: "user_role", optional: false });
    expect(field(model, "users", "tags")).toMatchObject({ type: "text", list: true, optional: true });
    expect(field(model, "users", "created_at")).toMatchObject({ type: "timestamptz(6)", default: "now()" });
    expect(field(model, "users", "id").pk).toBe(true);
    expect(table(model, "posts").indexes).toEqual([["body"]]);
    expect(model.enums.user_role?.values.map((v) => v.name)).toEqual(["admin", "member"]);
    expect(model.relations).toEqual([
      expect.objectContaining({ child: "posts", parent: "users", fields: ["author_id"], onDelete: "Cascade" }),
      expect.objectContaining({
        child: "posts",
        field: "editor_id",
        name: "posts_editor_fk",
        optional: true,
        onDelete: "SetNull",
      }),
    ]);
  });

  it("keeps NOT NULL that follows other column constraints", () => {
    const path = write(
      "schema.sql",
      "CREATE TABLE t (a int DEFAULT 1 NOT NULL, b text COLLATE \"C\" NOT NULL, c int UNIQUE NOT NULL, d int);",
    );
    const model = extractSql(path);
    expect(["a", "b", "c", "d"].map((c) => field(model, "t", c).optional)).toEqual([false, false, false, true]);
  });

  it("names tables outside public as schema:table", () => {
    const path = write(
      "schema.sql",
      "CREATE TABLE public.a (id int PRIMARY KEY); CREATE TABLE audit.log (id int, a_id int REFERENCES public.a(id));",
    );
    const model = extractSql(path);
    expect(model.models.map((m) => m.name)).toEqual(["a", "audit:log"]);
    expect(model.relations[0]).toMatchObject({ child: "audit:log", parent: "a" });
  });
});

describe("extractSql on a migrations folder", () => {
  it("replays renames, drops and enum changes in path order and skips down files", () => {
    write("db/migrations/001_init.sql", "CREATE TYPE status AS ENUM ('open', 'closed');\nCREATE TABLE accounts (id int PRIMARY KEY, name text);\nCREATE TABLE notes (id int PRIMARY KEY, account_id int, state status);");
    write("db/migrations/002_fk.sql", "ALTER TABLE notes ADD CONSTRAINT notes_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id);");
    write("db/migrations/003_rename.sql", "ALTER TABLE accounts RENAME TO orgs;\nALTER TABLE orgs RENAME COLUMN name TO title;\nALTER TABLE notes ALTER COLUMN account_id SET NOT NULL;");
    write("db/migrations/004_enum.sql", "ALTER TYPE status ADD VALUE 'draft' BEFORE 'open';\nALTER TYPE status RENAME VALUE 'closed' TO 'done';");
    write("db/migrations/005_drop.sql", "CREATE TABLE scratch (id int, orgs_id int REFERENCES orgs(id));\nDROP TABLE scratch;\nALTER TABLE notes ADD COLUMN body text;\nALTER TABLE notes DROP COLUMN body;");
    write("db/migrations/005_drop.down.sql", "DROP TABLE orgs;");
    write("db/migrations/down/006.sql", "DROP TABLE notes;");
    const model = extractSql(join(dir, "db/migrations"));
    expect(model.models.map((m) => m.name)).toEqual(["notes", "orgs"]);
    expect(table(model, "orgs").fields.map((f) => f.name)).toEqual(["id", "title"]);
    expect(table(model, "notes").fields.map((f) => f.name)).toEqual(["id", "account_id", "state"]);
    expect(field(model, "notes", "account_id")).toMatchObject({ fk: true, optional: false });
    expect(model.relations).toEqual([
      expect.objectContaining({ child: "notes", parent: "orgs", fields: ["account_id"], references: ["id"] }),
    ]);
    expect(model.enums.status?.values.map((v) => v.name)).toEqual(["draft", "open", "done"]);
  });
});
