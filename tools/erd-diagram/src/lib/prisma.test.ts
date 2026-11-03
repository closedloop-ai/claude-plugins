import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPrisma } from "./prisma.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "erd-prisma-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// A signed-up person.
model User {
  id      String   @id @default(uuid())
  email   String   @unique @map("email_address") // login address
  role    Role     @default(MEMBER)
  tags    String[] @db.Text
  profile Profile?
  posts   Post[]

  @@map("users")
}

model Profile {
  userId String @unique
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Post {
  authorId String
  slug     String
  author   User   @relation("Authored", fields: [authorId], references: [id])

  @@id([authorId, slug])
  @@index([slug(sort: Desc)])
}

enum Role {
  /// can do anything
  ADMIN
  MEMBER
}
`;

describe("extractPrisma", () => {
  it("reads models, fields, relations and enums", () => {
    writeFileSync(join(dir, "schema.prisma"), SCHEMA);
    const model = extractPrisma(join(dir, "schema.prisma"));
    const user = model.models.find((m) => m.name === "User");
    expect(user).toMatchObject({ table: "users", doc: "A signed-up person." });
    expect(user?.fields.find((f) => f.name === "email")).toMatchObject({
      column: "email_address",
      uk: true,
      doc: "login address",
    });
    expect(user?.fields.find((f) => f.name === "id")).toMatchObject({ pk: true, default: "uuid()" });
    expect(user?.fields.find((f) => f.name === "role")).toMatchObject({ kind: "enum", default: "MEMBER" });
    expect(user?.fields.find((f) => f.name === "tags")).toMatchObject({ list: true, dbType: "Text" });
    expect(user?.fields.find((f) => f.name === "posts")).toMatchObject({ kind: "relation", list: true });

    const post = model.models.find((m) => m.name === "Post");
    expect(post?.ids).toEqual(["authorId", "slug"]);
    expect(post?.indexes).toEqual([["slug"]]);
    expect(post?.fields.filter((f) => f.pk).map((f) => f.name)).toEqual(["authorId", "slug"]);

    expect(model.relations).toEqual([
      expect.objectContaining({ child: "Profile", parent: "User", oneToOne: true, onDelete: "Cascade" }),
      expect.objectContaining({ child: "Post", parent: "User", oneToOne: false, name: "Authored" }),
    ]);
    expect(model.enums.Role).toEqual({
      doc: "",
      values: [
        { name: "ADMIN", doc: "can do anything" },
        { name: "MEMBER", doc: "" },
      ],
    });
  });

  it("reads every .prisma file in a folder, skipping migrations", () => {
    mkdirSync(join(dir, "models"));
    mkdirSync(join(dir, "migrations"));
    writeFileSync(join(dir, "models", "a.prisma"), "model A {\n  id Int @id\n}\n");
    writeFileSync(join(dir, "b.prisma"), "model B {\n  id Int @id\n}\n");
    writeFileSync(join(dir, "migrations", "old.prisma"), "model Old {\n  id Int @id\n}\n");
    expect(extractPrisma(dir).models.map((m) => m.name)).toEqual(["B", "A"]);
  });
});
