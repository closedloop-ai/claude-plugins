/**
 * The normalized ERD model shared by every extractor, plus its validator.
 *
 * Model shape (what the HTML templates read):
 *   models:    [{name, table, doc, fields: [field], ids: [col], uniques: [[col]], indexes: [[col]]}]
 *   field:     {name, column, type, list, optional, default, dbType, doc, kind: scalar|enum|relation, pk, fk, uk}
 *   enums:     {EnumName: {doc, values: [{name, doc}]}}
 *   relations: [{child, parent, field, fields: [col], references: [col], optional, oneToOne, name, onDelete}]
 */

export type FieldKind = "scalar" | "enum" | "relation";

export interface Field {
  name: string;
  column: string;
  type: string;
  list: boolean;
  optional: boolean;
  default: string | null;
  dbType: string | null;
  doc: string;
  kind: FieldKind;
  pk: boolean;
  fk: boolean;
  uk: boolean;
}

export interface TableModel {
  name: string;
  table: string;
  doc: string;
  fields: Field[];
  ids: string[];
  uniques: string[][];
  indexes: string[][];
}

export interface EnumValue {
  name: string;
  doc: string;
}

export interface EnumDef {
  doc: string;
  values: EnumValue[];
}

export interface Relation {
  child: string;
  parent: string;
  field: string;
  fields: string[];
  references: string[];
  optional: boolean;
  oneToOne: boolean;
  name: string | null;
  onDelete: string | null;
}

export interface ErdModel {
  models: TableModel[];
  enums: Record<string, EnumDef>;
  relations: Relation[];
}

/** Catalog shape produced by the SQL extractor and turned into a model by finalize(). */
export interface RawColumn {
  name: string;
  type: string;
  notnull: boolean;
  default: string | null;
  doc: string;
}

export interface RawConstraint {
  name: string | null;
  type: "p" | "u" | "f";
  cols: string[];
  refSchema?: string;
  refTable?: string;
  refCols?: string[];
  onDelete?: string | null;
}

export interface RawIndex {
  name: string;
  cols: string[];
  unique: boolean;
  partial: boolean;
}

export interface RawTable {
  schema: string;
  name: string;
  doc: string;
  columns: RawColumn[];
  constraints: RawConstraint[];
  indexes: RawIndex[];
}

export interface RawEnum {
  schema: string;
  name: string;
  doc: string;
  values: string[];
}

export interface RawSchema {
  tables: RawTable[];
  enums: RawEnum[];
}

export const DEFAULT_EXCLUDE =
  "^(_prisma_migrations|schema_migrations|ar_internal_metadata|knex_migrations(_lock)?|__drizzle_migrations" +
  "|flyway_schema_history|goose_db_version|typeorm_migrations|_sqlx_migrations|django_migrations" +
  "|alembic_version|__EFMigrationsHistory|schema_version|spatial_ref_sys)$";

const TYPE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^character varying/, "varchar"],
  [/^character\b/, "char"],
  [/^timestamp(\(\d+\))? without time zone/, "timestamp$1"],
  [/^timestamp(\(\d+\))? with time zone/, "timestamptz$1"],
  [/^time(\(\d+\))? without time zone/, "time$1"],
  [/^time(\(\d+\))? with time zone/, "timetz$1"],
  [/^double precision/, "float8"],
  [/^bit varying/, "varbit"],
];

const QUOTED_SCHEMA_PREFIX = /^"[^"]+"\s*\.\s*"/;

/** Short display type for a SQL column type, and whether it is an array. */
export function shortType(raw: string): [string, boolean] {
  let t = raw.trim().replace(/\s+/g, " ");
  const isList = t.endsWith("[]");
  if (isList) t = t.slice(0, -2).trim();
  if (t.includes(".") && !t.startsWith('"')) {
    t = t.split(".").at(-1) ?? t;
  } else if (QUOTED_SCHEMA_PREFIX.test(t)) {
    t = t.slice(t.indexOf(".") + 1).trim();
  }
  t = t.replaceAll('"', "");
  const low = t.toLowerCase();
  for (const [pattern, replacement] of TYPE_ALIASES) {
    if (pattern.test(low)) return [low.replace(pattern, replacement), isList];
  }
  return [t, isList];
}

export function modelName(schema: string, name: string, multiSchema: boolean): string {
  return !multiSchema || schema === "public" ? name : `${schema}:${name}`;
}

export function keyOf(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

function sameSet(a: readonly string[], b: ReadonlySet<string>): boolean {
  const s = new Set(a);
  return s.size === b.size && [...s].every((x) => b.has(x));
}

export function byString(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Turn the raw catalog shape {tables, enums} into the ERD model. */
export function finalize(raw: RawSchema, exclude?: string | null): ErdModel {
  const ex = new RegExp(`^(?:${exclude || DEFAULT_EXCLUDE})`);
  const tables = raw.tables.filter((t) => !ex.test(t.name));
  const schemas = new Set([...tables.map((t) => t.schema), ...raw.enums.map((e) => e.schema)]);
  const multi = schemas.size > 1;
  const enumNames = new Map<string, string>();
  const enums: Record<string, EnumDef> = Object.create(null);
  for (const e of raw.enums) {
    const nm = modelName(e.schema, e.name, multi);
    enumNames.set(e.name, nm);
    enumNames.set(`${e.schema}.${e.name}`, nm);
    enums[nm] = { doc: e.doc || "", values: e.values.map((v) => ({ name: v, doc: "" })) };
  }
  const names = new Map(tables.map((t) => [keyOf(t.schema, t.name), modelName(t.schema, t.name, multi)]));

  const models: TableModel[] = [];
  const relations: Relation[] = [];
  for (const t of tables) {
    const mname = names.get(keyOf(t.schema, t.name)) ?? t.name;
    const cons = t.constraints;
    const pk = cons.find((c) => c.type === "p")?.cols ?? [];
    const uniques = [
      ...cons.filter((c) => c.type === "u").map((c) => c.cols),
      ...t.indexes.filter((i) => i.unique && !i.partial).map((i) => i.cols),
    ];
    const indexes = t.indexes.filter((i) => !(i.unique && !i.partial)).map((i) => i.cols);
    const fks = cons.filter((c) => c.type === "f" && names.has(keyOf(c.refSchema ?? "", c.refTable ?? "")));
    const fkCols = new Set(fks.flatMap((c) => c.cols));
    const singleUniques = new Set(uniques.filter((u) => u.length === 1).map((u) => u[0]));
    const cols = new Map(t.columns.map((c) => [c.name, c]));
    const fields: Field[] = t.columns.map((c) => {
      let [typ, isList] = shortType(c.type);
      const clean = c.type.replaceAll('"', "").trim();
      const kind: FieldKind = enumNames.has(typ) || enumNames.has(clean) ? "enum" : "scalar";
      if (kind === "enum") typ = enumNames.get(typ) ?? enumNames.get(clean) ?? typ;
      const isPk = pk.includes(c.name);
      return {
        name: c.name,
        column: c.name,
        type: typ,
        list: isList,
        optional: !c.notnull && !isPk,
        default: c.default ?? null,
        dbType: null,
        doc: c.doc || "",
        kind,
        pk: isPk,
        fk: fkCols.has(c.name),
        uk: !isPk && singleUniques.has(c.name),
      };
    });
    const sets = [...uniques.map((u) => new Set(u)), ...(pk.length ? [new Set(pk)] : [])];
    for (const c of fks) {
      const parentKey = keyOf(c.refSchema ?? "", c.refTable ?? "");
      const parent = tables.find((x) => keyOf(x.schema, x.name) === parentKey);
      const refs = c.refCols?.length ? c.refCols : (parent?.constraints.find((k) => k.type === "p")?.cols ?? []);
      relations.push({
        child: mname,
        parent: names.get(parentKey) ?? "",
        field: c.cols.length === 1 ? (c.cols[0] ?? "") : c.name || c.cols.join(", "),
        fields: c.cols,
        references: refs,
        optional: c.cols.some((x) => cols.has(x) && !cols.get(x)?.notnull),
        oneToOne: sets.some((s) => sameSet(c.cols, s)),
        name: c.name,
        onDelete: c.onDelete ?? null,
      });
    }
    models.push({
      name: mname,
      table: t.name,
      doc: t.doc || "",
      fields,
      ids: pk.length > 1 ? pk : [],
      uniques,
      indexes,
    });
  }
  models.sort((a, b) => byString(a.name, b.name));
  return { models, enums, relations };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Check = "string" | "boolean" | "list";

const FIELD_KEYS: Record<string, Check> = {
  name: "string",
  column: "string",
  type: "string",
  list: "boolean",
  optional: "boolean",
  kind: "string",
  pk: "boolean",
  fk: "boolean",
  uk: "boolean",
};

const REL_KEYS: Record<string, Check> = {
  child: "string",
  parent: "string",
  field: "string",
  fields: "list",
  references: "list",
  optional: "boolean",
  oneToOne: "boolean",
};

function hasType(v: unknown, check: Check): boolean {
  return check === "list" ? Array.isArray(v) : typeof v === check;
}

function q(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

function fieldNames(m: Record<string, unknown> | undefined): Set<unknown> {
  const fields = m?.fields;
  return new Set(Array.isArray(fields) ? fields.filter(isObject).map((f) => f.name) : []);
}

function validateFields(where: string, m: Record<string, unknown>, enums: unknown, problems: string[]): void {
  const fields = Array.isArray(m.fields) ? m.fields : [];
  fields.forEach((f: unknown, j) => {
    if (!isObject(f)) {
      problems.push(`${where}.fields[${j}] must be an object`);
      return;
    }
    for (const [key, check] of Object.entries(FIELD_KEYS)) {
      if (!hasType(f[key], check)) problems.push(`${where}.fields[${j}].${key} must be a ${check}`);
    }
    if (!["scalar", "enum", "relation"].includes(f.kind as string)) {
      problems.push(`${where}.fields[${j}].kind must be scalar, enum or relation`);
    }
    if (f.kind === "enum" && !(isObject(enums) && typeof f.type === "string" && Object.hasOwn(enums, f.type))) {
      problems.push(`${where}.fields[${j}]: enum type ${q(f.type)} is not in enums`);
    }
  });
}

function validateModels(models: unknown[], enums: unknown, problems: string[]): Map<string, Record<string, unknown>> {
  const seen = new Map<string, Record<string, unknown>>();
  models.forEach((m, i) => {
    const where = `models[${i}]`;
    if (!isObject(m) || typeof m.name !== "string" || !m.name) {
      problems.push(`${where}: needs a non-empty string name`);
      return;
    }
    if (/[./#]/.test(m.name)) problems.push(`${where}: name ${q(m.name)} must not contain '.', '/' or '#'`);
    if (seen.has(m.name)) problems.push(`${where}: duplicate model name ${q(m.name)}`);
    seen.set(m.name, m);
    for (const key of ["table", "doc"]) {
      if (typeof m[key] !== "string") problems.push(`${where}.${key} must be a string`);
    }
    for (const key of ["ids", "uniques", "indexes", "fields"]) {
      if (!Array.isArray(m[key])) problems.push(`${where}.${key} must be a list`);
    }
    validateFields(where, m, enums, problems);
  });
  return seen;
}

function validateRelations(
  relations: unknown[],
  seen: Map<string, Record<string, unknown>>,
  problems: string[],
): void {
  relations.forEach((r, i) => {
    if (!isObject(r)) {
      problems.push(`relations[${i}] must be an object`);
      return;
    }
    for (const [key, check] of Object.entries(REL_KEYS)) {
      if (!hasType(r[key], check)) problems.push(`relations[${i}].${key} must be a ${check}`);
    }
    const child = typeof r.child === "string" ? seen.get(r.child) : undefined;
    const parent = typeof r.parent === "string" ? seen.get(r.parent) : undefined;
    if (!child || !parent) {
      problems.push(`relations[${i}]: child and parent must both be model names`);
      return;
    }
    const cols = fieldNames(child);
    const pcols = fieldNames(parent);
    const fields = Array.isArray(r.fields) ? r.fields : [];
    const refs = Array.isArray(r.references) ? r.references : [];
    if (!fields.length || fields.some((c) => !cols.has(c))) {
      problems.push(`relations[${i}]: fields ${q(r.fields)} must be columns of ${String(r.child)}`);
    }
    if (!refs.length || refs.some((c) => !pcols.has(c))) {
      problems.push(`relations[${i}]: references ${q(r.references)} must be columns of ${String(r.parent)}`);
    }
  });
}

/** Problems with a model; an empty list means it is safe to render. */
export function validateModel(model: unknown): string[] {
  if (!isObject(model)) return ["top level must be an object with models, enums, relations"];
  const models = model.models;
  if (!Array.isArray(models) || !models.length) return ["models must be a non-empty list"];
  const problems: string[] = [];
  const enums = model.enums ?? {};
  const relations = model.relations ?? [];
  if (!isObject(enums)) problems.push("enums must be an object keyed by enum name");
  if (!Array.isArray(relations)) problems.push("relations must be a list");
  const seen = validateModels(models, enums, problems);
  validateRelations(Array.isArray(relations) ? relations : [], seen, problems);
  return problems;
}
