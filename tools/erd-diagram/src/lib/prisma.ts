/** Extract a Prisma schema (one file, or a folder of .prisma files) into the ERD model. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { byString, type EnumDef, type ErdModel, type Field, type Relation, type TableModel } from "./model.js";

const BLOCK_RE = /^(model|enum)\s+(\w+)\s*\{/;
const FIELD_RE = /^(\w+)\s+([\w.]+(?:\([^)]*\))?)(\[\])?(\?)?\s*(.*)$/;
const BLOCK_FIELDS_RE = /@@(unique|id|index)\(\s*(?:fields:\s*)?\[([^\]]*)\]/g;
const MAP_RE = /@map\("([^"]+)"\)/;
const BLOCK_MAP_RE = /@@map\("([^"]+)"\)/;
const REL_NAME_RE = /@relation\(\s*(?:name:\s*)?"([^"]+)"/;
const ON_DELETE_RE = /onDelete:\s*(\w+)/;
const DB_TYPE_RE = /@db\.(\w+(?:\([^)]*\))?)/;
const FIELDS_ARG_RE = /fields:\s*\[([^\]]*)\]/;
const REFERENCES_ARG_RE = /references:\s*\[([^\]]*)\]/;
const ENUM_VALUE_RE = /^(\w+)/;
const UNIQUE_OR_ID_RE = /@(unique|id)\b/;
const FIELD_ID_RE = /(^|\s)@id\b/;
const LINE_SPLIT_RE = /\r\n|\r|\n/;
const SKIP_DIRS = new Set(["node_modules", ".git", "migrations"]);

interface ParsedField extends Omit<Field, "kind" | "pk" | "fk" | "uk"> {
  attrs: string;
}

interface ParsedModel extends Omit<TableModel, "fields"> {
  fields: ParsedField[];
}

export function prismaFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name.endsWith(".prisma")) {
        found.push(full);
      }
    }
  };
  walk(path);
  return found.sort(byString);
}

function findBalanced(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return text.slice(start + 1);
}

function defaultOf(attrs: string): string | null {
  const idx = attrs.indexOf("@default(");
  return idx >= 0 ? findBalanced(attrs, idx + "@default".length) : null;
}

function splitCodeComment(line: string): [string, string | null] {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inStr = !inStr;
    if (!inStr && line.startsWith("//", i)) return [line.slice(0, i).trim(), line.slice(i).replace(/^\/+/, "").trim()];
  }
  return [line.trim(), null];
}

function names(raw: string): string[] {
  return raw
    .split(",")
    .filter((p) => p.trim())
    .map((p) => p.trim().split("(")[0] ?? "");
}

type Block = { kind: "model"; model: ParsedModel } | { kind: "enum"; name: string; def: EnumDef };

function parseBlockLine(block: Block, code: string, doc: string): void {
  if (block.kind === "enum") {
    const vm = ENUM_VALUE_RE.exec(code);
    if (vm?.[1]) block.def.values.push({ name: vm[1], doc });
    return;
  }
  const current = block.model;
  if (code.startsWith("@@")) {
    const mm = BLOCK_MAP_RE.exec(code);
    if (mm?.[1]) current.table = mm[1];
    for (const [, typ, cols] of code.matchAll(BLOCK_FIELDS_RE)) {
      if (typ === "id") current.ids.push(...names(cols ?? ""));
      else (typ === "unique" ? current.uniques : current.indexes).push(names(cols ?? ""));
    }
    return;
  }
  const fm = FIELD_RE.exec(code);
  if (!fm) return;
  const [, name = "", ftype = "", isList, isOpt, attrs = ""] = fm;
  current.fields.push({
    name,
    column: MAP_RE.exec(attrs)?.[1] ?? name,
    type: ftype,
    list: Boolean(isList),
    optional: Boolean(isOpt),
    attrs,
    default: defaultOf(attrs),
    dbType: DB_TYPE_RE.exec(attrs)?.[1] ?? null,
    doc,
  });
}

function parseLines(lines: string[]): { models: ParsedModel[]; enums: Record<string, EnumDef> } {
  const models: ParsedModel[] = [];
  const enums: Record<string, EnumDef> = Object.create(null);
  let block: Block | null = null;
  let pending: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (stripped.startsWith("//")) {
      pending.push(stripped.replace(/^\/+/, "").trim());
      continue;
    }
    const [code, trailing] = splitCodeComment(raw);
    if (!code) {
      pending = [];
      continue;
    }
    if (block === null) {
      const m = BLOCK_RE.exec(code);
      if (m) {
        const doc = pending.join("\n").trim();
        const name = m[2] ?? "";
        block =
          m[1] === "model"
            ? { kind: "model", model: { name, table: name, doc, fields: [], ids: [], uniques: [], indexes: [] } }
            : { kind: "enum", name, def: { doc, values: [] } };
      }
      pending = [];
      continue;
    }
    if (code === "}") {
      if (block.kind === "model") models.push(block.model);
      else enums[block.name] = block.def;
      block = null;
      pending = [];
      continue;
    }
    const doc = [...pending, ...(trailing ? [trailing] : [])].join("\n").trim();
    pending = [];
    parseBlockLine(block, code, doc);
  }
  return { models, enums };
}

function relationFor(m: ParsedModel, f: ParsedField): Relation | null {
  const fm = FIELDS_ARG_RE.exec(f.attrs);
  if (!fm) return null;
  const rm = REFERENCES_ARG_RE.exec(f.attrs);
  const fks = names(fm[1] ?? "");
  const refs = rm ? names(rm[1] ?? "") : [];
  const keySets = [...m.uniques, ...(m.ids.length ? [m.ids] : [])].map((u) => new Set(u));
  const fkSet = new Set(fks);
  const sameAsKey = keySets.some((s) => s.size === fkSet.size && [...fkSet].every((x) => s.has(x)));
  const one =
    sameAsKey || (fks.length === 1 && m.fields.some((x) => x.name === fks[0] && UNIQUE_OR_ID_RE.test(x.attrs)));
  return {
    child: m.name,
    parent: f.type,
    field: f.name,
    fields: fks,
    references: refs,
    optional: f.optional,
    oneToOne: one,
    name: REL_NAME_RE.exec(f.attrs)?.[1] ?? null,
    onDelete: ON_DELETE_RE.exec(f.attrs)?.[1] ?? null,
  };
}

function buildModel(parsed: ParsedModel[], enums: Record<string, EnumDef>): ErdModel {
  const byName = new Set(parsed.map((m) => m.name));
  const kindOf = (type: string): Field["kind"] => {
    if (byName.has(type)) return "relation";
    return Object.hasOwn(enums, type) ? "enum" : "scalar";
  };
  const relations: Relation[] = [];
  for (const m of parsed) {
    for (const f of m.fields) {
      if (kindOf(f.type) !== "relation") continue;
      const rel = relationFor(m, f);
      if (rel) relations.push(rel);
    }
  }
  const models: TableModel[] = parsed.map((m) => {
    const fk = new Set(relations.filter((r) => r.child === m.name).flatMap((r) => r.fields));
    const singleUniques = new Set(m.uniques.filter((u) => u.length === 1).map((u) => u[0]));
    const fields: Field[] = m.fields.map(({ attrs, ...f }) => {
      const pk = FIELD_ID_RE.test(attrs) || m.ids.includes(f.name);
      return {
        ...f,
        kind: kindOf(f.type),
        pk,
        fk: fk.has(f.name),
        uk: !pk && (attrs.includes("@unique") || singleUniques.has(f.name)),
      };
    });
    return { ...m, fields };
  });
  return { models, enums, relations };
}

export function extractPrisma(path: string): ErdModel {
  const files = prismaFiles(path);
  if (!files.length) throw new Error(`No .prisma files found at ${path}`);
  const lines: string[] = [];
  for (const p of files) {
    lines.push(...readFileSync(p, "utf8").split(LINE_SPLIT_RE), "");
  }
  const { models, enums } = parseLines(lines);
  return buildModel(models, enums);
}
