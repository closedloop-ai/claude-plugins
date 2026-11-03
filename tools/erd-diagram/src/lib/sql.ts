/**
 * Extract a Postgres schema from SQL DDL into the ERD model.
 *
 * Accepts one file (a pg_dump --schema-only dump, Rails structure.sql, a hand-written
 * schema.sql) or a directory of migration .sql files, applied in sorted path order.
 * Handles CREATE/ALTER/DROP TABLE, columns, constraints, indexes, enums and comments;
 * everything else is ignored.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { byString, type ErdModel, finalize, keyOf, type RawConstraint, type RawSchema } from "./model.js";

const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const QNAME = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const IDENT_G = new RegExp(IDENT, "g");
const MIGRATION_SKIP_DIRS = new Set(["node_modules", ".git", "down", "rollback"]);
const DOWN_FILE_RE = /(^|[._-])down\.sql$/;
const DOLLAR_TAG_RE = /\$([A-Za-z_]*)\$/y;
const COLUMN_STOP = /\b(NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|CONSTRAINT|COLLATE|GENERATED)\b/iy;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const ON_DELETE_RE = /ON\s+DELETE\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)/i;
const WHERE_RE = /\bWHERE\b/i;
const ACTION_MAP: Record<string, string> = {
  cascade: "Cascade",
  restrict: "Restrict",
  "no action": "NoAction",
  "set null": "SetNull",
  "set default": "SetDefault",
};

const compiled = new Map<string, RegExp>();

/** Python re.match: the pattern must match at the start of the text. */
function match(pattern: string, text: string, flags = ""): RegExpExecArray | null {
  const key = `${flags}/${pattern}`;
  let re = compiled.get(key);
  if (!re) {
    re = new RegExp(`^(?:${pattern})`, flags);
    compiled.set(key, re);
  }
  return re.exec(text);
}

export function sqlFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!MIGRATION_SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name.endsWith(".sql") && !DOWN_FILE_RE.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(path);
  return found.sort(byString);
}

function quotedEnd(text: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === quote) {
      if (text[j + 1] === quote) {
        j += 2;
        continue;
      }
      break;
    }
    j++;
  }
  return j;
}

function skipComment(text: string, i: number): { next: number; filler: string } | null {
  if (text.startsWith("--", i)) {
    const j = text.indexOf("\n", i);
    return { next: j < 0 ? text.length : j, filler: "" };
  }
  if (text.startsWith("/*", i)) {
    const j = text.indexOf("*/", i + 2);
    return { next: j < 0 ? text.length : j + 2, filler: " " };
  }
  return null;
}

function dollarQuoteEnd(text: string, i: number): number | null {
  DOLLAR_TAG_RE.lastIndex = i;
  const m = DOLLAR_TAG_RE.exec(text);
  if (!m) return null;
  const tag = m[0];
  const j = text.indexOf(tag, i + tag.length);
  return j < 0 ? text.length : j + tag.length;
}

/** Split SQL text into statements, skipping comments and respecting quotes and dollar quoting. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = text.length;
  const flush = (): void => {
    const stmt = buf.trim();
    if (stmt) out.push(stmt);
    buf = "";
  };
  while (i < n) {
    const ch = text[i] ?? "";
    const comment = skipComment(text, i);
    if (comment) {
      buf += comment.filler;
      i = comment.next;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const j = quotedEnd(text, i, ch);
      buf += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const end = dollarQuoteEnd(text, i);
      if (end !== null) {
        buf += text.slice(i, end);
        i = end;
        continue;
      }
    }
    if (ch === ";") {
      flush();
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function unquote(ident: string): string {
  const s = ident.trim();
  return s.startsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s.toLowerCase();
}

function idents(raw: string): string[] {
  return raw.match(IDENT_G) ?? [];
}

/** [schema, name] of a possibly schema-qualified identifier. */
function qualified(raw: string): [string, string] {
  const parts = idents(raw);
  if (parts.length >= 2) return [unquote(parts.at(-2) ?? ""), unquote(parts.at(-1) ?? "")];
  return ["public", unquote(parts[0] ?? "")];
}

function qkey(raw: string): string {
  const [schema, name] = qualified(raw);
  return keyOf(schema, name);
}

function splitTop(body: string, sep = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  let inQ: string | null = null;
  for (const ch of body) {
    if (inQ) {
      buf += ch;
      if (ch === inQ) inQ = null;
    } else if (ch === "'" || ch === '"') {
      inQ = ch;
      buf += ch;
    } else if (ch === "(") {
      depth++;
      buf += ch;
    } else if (ch === ")") {
      depth--;
      buf += ch;
    } else if (ch === sep && depth === 0) {
      parts.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/** [inside, endIndex] for the parenthesised group opening at text[start]. */
function parenBody(text: string, start: number): [string, number] {
  let depth = 0;
  let inQ: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === inQ) inQ = null;
      continue;
    }
    if (ch === "'" || ch === '"') inQ = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return [text.slice(start + 1, i), i + 1];
    }
  }
  return [text.slice(start + 1), text.length];
}

function sqlString(raw: string): string | null {
  const m = /^E?'((?:[^']|'')*)'/s.exec(raw.trim());
  return m ? (m[1] ?? "").replaceAll("''", "'") : null;
}

/** First COLUMN_STOP match in text that sits outside parentheses and quotes. */
function topLevelStop(text: string): { index: number; end: number } | null {
  let depth = 0;
  let inQ: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inQ) {
      if (ch === inQ) inQ = null;
      continue;
    }
    if (ch === "'" || ch === '"') inQ = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (i === 0 || !WORD_CHAR_RE.test(text[i - 1] ?? ""))) {
      COLUMN_STOP.lastIndex = i;
      const m = COLUMN_STOP.exec(text);
      if (m) return { index: i, end: i + m[0].length };
    }
  }
  return null;
}

function stopAtStart(text: string): number | null {
  COLUMN_STOP.lastIndex = 0;
  const m = COLUMN_STOP.exec(text);
  return m ? m[0].length : null;
}

interface Column {
  name: string;
  type: string;
  notnull: boolean;
  default: string | null;
  doc: string;
}

interface Constraint {
  name: string | null;
  type: "p" | "u" | "f";
  cols: string[];
  ref?: string;
  refCols?: string[];
  onDelete?: string | null;
}

interface Table {
  schema: string;
  name: string;
  doc: string;
  columns: Map<string, Column>;
  constraints: Constraint[];
}

interface Index {
  table: string;
  cols: string[];
  unique: boolean;
  partial: boolean;
}

interface EnumType {
  values: string[];
  doc: string;
}

const isForeignTo = (key: string) => (c: Constraint) => c.type === "f" && c.ref === key;

export class Schema {
  tables = new Map<string, Table>();
  enums = new Map<string, EnumType>();
  indexes = new Map<string, Index>();

  private newTable(schema: string, name: string): Table {
    const t: Table = { schema, name, doc: "", columns: new Map(), constraints: [] };
    this.tables.set(keyOf(schema, name), t);
    return t;
  }

  private addColumn(t: Table, item: string): void {
    const m = match(`(${IDENT})\\s+(.*)$`, item, "s");
    if (!m) return;
    const name = unquote(m[1] ?? "");
    const rest = (m[2] ?? "").trim();
    const stop = topLevelStop(rest);
    const typeText = (stop ? rest.slice(0, stop.index) : rest).trim();
    const tail = stop ? rest.slice(stop.index) : "";
    const col: Column = { name, type: typeText, notnull: false, default: null, doc: "" };
    t.columns.set(name, col);
    this.columnConstraints(t, col, tail);
  }

  private columnConstraints(t: Table, col: Column, tail: string): void {
    let pos = 0;
    while (pos < tail.length) {
      let seg = tail.slice(pos).trimStart();
      pos = tail.length - seg.length;
      if (!seg) break;
      const m = match(`CONSTRAINT\\s+(${IDENT})\\s*`, seg, "i");
      let cname: string | null = null;
      if (m) {
        cname = unquote(m[1] ?? "");
        seg = seg.slice(m[0].length);
        pos += m[0].length;
      }
      const skip = stopAtStart(seg) ?? 1;
      const next = topLevelStop(seg.slice(skip));
      const end = next ? next.index + skip : seg.length;
      const part = seg.slice(0, end).trim();
      pos += end;
      this.columnConstraint(t, col, part, cname);
    }
  }

  private columnConstraint(t: Table, col: Column, part: string, cname: string | null): void {
    const up = part.toUpperCase();
    if (up.startsWith("NOT NULL")) {
      col.notnull = true;
    } else if (up.startsWith("PRIMARY KEY")) {
      col.notnull = true;
      t.constraints.push({ name: cname, type: "p", cols: [col.name] });
    } else if (up.startsWith("UNIQUE")) {
      t.constraints.push({ name: cname, type: "u", cols: [col.name] });
    } else if (up.startsWith("DEFAULT")) {
      col.default = part.slice("DEFAULT".length).trim();
    } else if (up.startsWith("GENERATED")) {
      col.default = part;
    } else if (up.startsWith("REFERENCES")) {
      const fk = this.references(part.slice("REFERENCES".length), [col.name], cname);
      if (fk) t.constraints.push(fk);
    }
  }

  private references(text: string, cols: string[], cname: string | null): Constraint | null {
    const m = match(`\\s*(${QNAME})\\s*(\\(([^)]*)\\))?(.*)$`, text, "si");
    if (!m) return null;
    const refCols = m[3] ? splitTop(m[3]).map(unquote) : [];
    const od = ON_DELETE_RE.exec(m[4] ?? "");
    const action = od ? (ACTION_MAP[(od[1] ?? "").toLowerCase().replace(/\s+/g, " ")] ?? null) : null;
    return { name: cname, type: "f", cols, ref: qkey(m[1] ?? ""), refCols, onDelete: action };
  }

  private tableConstraint(t: Table, raw: string): void {
    let cname: string | null = null;
    let item = raw;
    const m = match(`CONSTRAINT\\s+(${IDENT})\\s+(.*)$`, item, "si");
    if (m) {
      cname = unquote(m[1] ?? "");
      item = m[2] ?? "";
    }
    const up = item.toUpperCase();
    const open = item.indexOf("(");
    if (open < 0) return;
    if (up.startsWith("PRIMARY KEY")) {
      const [body] = parenBody(item, open);
      const cols = splitTop(body).map(unquote);
      t.constraints.push({ name: cname, type: "p", cols });
      for (const c of cols) {
        const col = t.columns.get(c);
        if (col) col.notnull = true;
      }
    } else if (up.startsWith("UNIQUE")) {
      const [body] = parenBody(item, open);
      t.constraints.push({ name: cname, type: "u", cols: splitTop(body).map(unquote) });
    } else if (up.startsWith("FOREIGN KEY")) {
      const [body, end] = parenBody(item, open);
      const rest = item.slice(end).trim();
      if (rest.toUpperCase().startsWith("REFERENCES")) {
        const fk = this.references(rest.slice("REFERENCES".length), splitTop(body).map(unquote), cname);
        if (fk) t.constraints.push(fk);
      }
    }
  }

  private isConstraint(item: string): boolean {
    return match("(CONSTRAINT|PRIMARY\\s+KEY|UNIQUE|FOREIGN\\s+KEY|CHECK|EXCLUDE|LIKE)\\b", item, "i") !== null;
  }

  createTable(stmt: string): void {
    const m = match(
      `CREATE\\s+(?:(?:GLOBAL|LOCAL)\\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QNAME})\\s*`,
      stmt,
      "is",
    );
    if (!m) return;
    const rest = stmt.slice(m[0].length);
    if (match("(PARTITION\\s+OF|OF\\s|AS\\s)", rest, "i") || !rest.startsWith("(")) return;
    const [schema, name] = qualified(m[1] ?? "");
    if (this.tables.has(keyOf(schema, name))) return;
    const t = this.newTable(schema, name);
    const [body] = parenBody(rest, 0);
    for (const item of splitTop(body)) {
      if (this.isConstraint(item)) this.tableConstraint(t, item);
      else this.addColumn(t, item);
    }
  }

  alterTable(stmt: string): void {
    const m = match(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QNAME})\\s+(.*)$`, stmt, "is");
    if (!m) return;
    const [schema, name] = qualified(m[1] ?? "");
    const key = keyOf(schema, name);
    const t = this.tables.get(key);
    const actions = (m[2] ?? "").trim();
    const rn = match(`RENAME\\s+TO\\s+(${IDENT})`, actions, "i");
    if (rn) {
      if (t) this.renameTable(key, schema, unquote(rn[1] ?? ""));
      return;
    }
    if (!t) return;
    const rc = match(`RENAME\\s+(?:COLUMN\\s+)?(${IDENT})\\s+TO\\s+(${IDENT})`, actions, "i");
    if (rc && !match("RENAME\\s+CONSTRAINT", actions, "i")) {
      this.renameColumn(key, unquote(rc[1] ?? ""), unquote(rc[2] ?? ""));
      return;
    }
    const rcon = match(`RENAME\\s+CONSTRAINT\\s+(${IDENT})\\s+TO\\s+(${IDENT})`, actions, "i");
    if (rcon) {
      const from = unquote(rcon[1] ?? "");
      for (const c of t.constraints) if (c.name === from) c.name = unquote(rcon[2] ?? "");
      return;
    }
    for (const act of splitTop(actions)) this.alterAction(key, t, act.trim());
  }

  private alterAction(key: string, t: Table, act: string): void {
    const up = act.toUpperCase();
    const add = match("ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(.*)$", act, "is");
    if (add) {
      const body = add[1] ?? "";
      if (!match("ADD\\s+COLUMN", act, "i") && this.isConstraint(body)) this.tableConstraint(t, body);
      else this.addColumn(t, body);
      return;
    }
    const dc = match(`DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, act, "i");
    if (dc) {
      const name = unquote(dc[1] ?? "");
      t.constraints = t.constraints.filter((c) => c.name !== name);
      return;
    }
    const drop = match(`DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT})`, act, "i");
    if (drop && !up.startsWith("DROP DEFAULT") && !up.startsWith("DROP NOT")) {
      this.dropColumn(key, t, unquote(drop[1] ?? ""));
      return;
    }
    const alter = match(`ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(.*)$`, act, "is");
    if (alter) {
      const col = t.columns.get(unquote(alter[1] ?? ""));
      if (col) this.alterColumn(col, (alter[2] ?? "").trim());
    }
  }

  private dropColumn(key: string, t: Table, name: string): void {
    t.columns.delete(name);
    t.constraints = t.constraints.filter((c) => !c.cols.includes(name));
    for (const other of this.tables.values()) {
      other.constraints = other.constraints.filter((c) => !(isForeignTo(key)(c) && c.refCols?.includes(name)));
    }
  }

  private alterColumn(col: Column, sub: string): void {
    if (match("SET\\s+NOT\\s+NULL", sub, "i")) col.notnull = true;
    else if (match("DROP\\s+NOT\\s+NULL", sub, "i")) col.notnull = false;
    else if (match("SET\\s+DEFAULT", sub, "i")) col.default = sub.replace(/^SET\s+DEFAULT\s+/i, "");
    else if (match("DROP\\s+DEFAULT", sub, "i")) col.default = null;
    else {
      const tm = match("(?:SET\\s+DATA\\s+)?TYPE\\s+(.*?)(?:\\s+USING\\s+.*)?$", sub, "is");
      if (tm) col.type = (tm[1] ?? "").trim();
    }
  }

  private renameTable(old: string, schema: string, name: string): void {
    const t = this.tables.get(old);
    if (!t) return;
    const key = keyOf(schema, name);
    this.tables.delete(old);
    t.name = name;
    this.tables.set(key, t);
    for (const other of this.tables.values()) {
      for (const c of other.constraints) if (isForeignTo(old)(c)) c.ref = key;
    }
    for (const idx of this.indexes.values()) if (idx.table === old) idx.table = key;
  }

  private renameColumn(key: string, old: string, name: string): void {
    const t = this.tables.get(key);
    if (!t?.columns.has(old)) return;
    const swap = (x: string): string => (x === old ? name : x);
    t.columns = new Map(
      [...t.columns].map(([k, v]) => {
        if (k !== old) return [k, v];
        v.name = name;
        return [name, v];
      }),
    );
    for (const c of t.constraints) c.cols = c.cols.map(swap);
    for (const other of this.tables.values()) {
      for (const c of other.constraints) if (isForeignTo(key)(c)) c.refCols = (c.refCols ?? []).map(swap);
    }
    for (const idx of this.indexes.values()) if (idx.table === key) idx.cols = idx.cols.map(swap);
  }

  createIndex(stmt: string): void {
    const m = match(
      `CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QNAME})?\\s*` +
        `ON\\s+(?:ONLY\\s+)?(${QNAME})\\s*(?:USING\\s+\\w+\\s*)?`,
      stmt,
      "is",
    );
    if (!m) return;
    const rest = stmt.slice(m[0].length);
    const open = rest.indexOf("(");
    if (open < 0) return;
    const [body, end] = parenBody(rest, open);
    const cols = splitTop(body).map((part) => {
      const pm = match(`(${IDENT})(\\s+(ASC|DESC|NULLS\\s+\\w+|\\w+_ops))*\\s*$`, part.trim(), "i");
      return pm ? unquote(pm[1] ?? "") : part.trim();
    });
    const name = m[2] ? qualified(m[2])[1] : `idx_${this.indexes.size}`;
    this.indexes.set(name, {
      table: qkey(m[3] ?? ""),
      cols,
      unique: Boolean(m[1]),
      partial: WHERE_RE.test(rest.slice(end)),
    });
  }

  drop(stmt: string): void {
    const m = match(
      "DROP\\s+(TABLE|INDEX|TYPE)\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(.*?)(\\s+(CASCADE|RESTRICT))?$",
      stmt,
      "is",
    );
    if (!m) return;
    const kind = (m[1] ?? "").toUpperCase();
    for (const raw of splitTop(m[2] ?? "")) {
      const [schema, name] = qualified(raw);
      const key = keyOf(schema, name);
      if (kind === "TABLE" && this.tables.has(key)) {
        this.tables.delete(key);
        for (const other of this.tables.values()) {
          other.constraints = other.constraints.filter((c) => !isForeignTo(key)(c));
        }
        this.indexes = new Map([...this.indexes].filter(([, v]) => v.table !== key));
      } else if (kind === "INDEX") {
        this.indexes.delete(name);
      } else if (kind === "TYPE") {
        this.enums.delete(key);
      }
    }
  }

  createType(stmt: string): void {
    const m = match(`CREATE\\s+TYPE\\s+(${QNAME})\\s+AS\\s+ENUM\\s*\\((.*)\\)\\s*$`, stmt, "is");
    if (!m) return;
    const values = splitTop(m[2] ?? "")
      .map(sqlString)
      .filter((v): v is string => v !== null);
    this.enums.set(qkey(m[1] ?? ""), { values, doc: "" });
  }

  alterType(stmt: string): void {
    const m = match(`ALTER\\s+TYPE\\s+(${QNAME})\\s+(.*)$`, stmt, "is");
    if (!m) return;
    const [schema] = qualified(m[1] ?? "");
    const key = qkey(m[1] ?? "");
    const e = this.enums.get(key);
    if (!e) return;
    const act = (m[2] ?? "").trim();
    const av = match(
      "ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?('(?:[^']|'')*')(?:\\s+(BEFORE|AFTER)\\s+('(?:[^']|'')*'))?",
      act,
      "i",
    );
    if (av) {
      const v = sqlString(av[1] ?? "") ?? "";
      if (e.values.includes(v)) return;
      const anchor = av[3] ? sqlString(av[3]) : null;
      const at = anchor === null ? -1 : e.values.indexOf(anchor);
      if (av[2] && at >= 0) e.values.splice(av[2].toUpperCase() === "BEFORE" ? at : at + 1, 0, v);
      else e.values.push(v);
      return;
    }
    const rv = match("RENAME\\s+VALUE\\s+('(?:[^']|'')*')\\s+TO\\s+('(?:[^']|'')*')", act, "i");
    if (rv) {
      const from = sqlString(rv[1] ?? "");
      const to = sqlString(rv[2] ?? "") ?? "";
      e.values = e.values.map((x) => (x === from ? to : x));
      return;
    }
    const rt = match(`RENAME\\s+TO\\s+(${IDENT})`, act, "i");
    if (rt) {
      this.enums.delete(key);
      this.enums.set(keyOf(schema, unquote(rt[1] ?? "")), e);
    }
  }

  comment(stmt: string): void {
    const m = match(
      `COMMENT\\s+ON\\s+(TABLE|COLUMN|TYPE)\\s+(${QNAME}(?:\\s*\\.\\s*${IDENT})?)\\s+IS\\s+(.*)$`,
      stmt,
      "is",
    );
    if (!m) return;
    const text = sqlString(m[3] ?? "") ?? "";
    const parts = idents(m[2] ?? "").map(unquote);
    const kind = (m[1] ?? "").toUpperCase();
    const last = (k: number): string => parts.at(-k) ?? "";
    if (kind === "COLUMN") {
      const key = parts.length >= 3 ? keyOf(last(3), last(2)) : keyOf("public", last(2));
      const col = this.tables.get(key)?.columns.get(last(1));
      if (col) col.doc = text;
      return;
    }
    const key = parts.length >= 2 ? keyOf(last(2), last(1)) : keyOf("public", last(1));
    const target = kind === "TABLE" ? this.tables.get(key) : this.enums.get(key);
    if (target) target.doc = text;
  }

  alterIndex(stmt: string): void {
    const m = match(`ALTER\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?(${QNAME})\\s+RENAME\\s+TO\\s+(${IDENT})`, stmt, "i");
    if (!m) return;
    const old = qualified(m[1] ?? "")[1];
    const idx = this.indexes.get(old);
    if (!idx) return;
    this.indexes.delete(old);
    this.indexes.set(unquote(m[2] ?? ""), idx);
  }

  apply(stmt: string): void {
    const head = stmt.slice(0, 40).toUpperCase();
    if (/^CREATE\s+(GLOBAL\s+|LOCAL\s+)?(TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE/.test(head)) this.createTable(stmt);
    else if (head.startsWith("ALTER TABLE")) this.alterTable(stmt);
    else if (/^CREATE\s+(UNIQUE\s+)?INDEX/.test(head)) this.createIndex(stmt);
    else if (head.startsWith("DROP ")) this.drop(stmt);
    else if (head.startsWith("CREATE TYPE")) this.createType(stmt);
    else if (head.startsWith("ALTER TYPE")) this.alterType(stmt);
    else if (head.startsWith("ALTER INDEX")) this.alterIndex(stmt);
    else if (head.startsWith("COMMENT ON")) this.comment(stmt);
  }

  toRaw(): RawSchema {
    const tables = [...this.tables].map(([key, t]) => ({
      schema: t.schema,
      name: t.name,
      doc: t.doc,
      columns: [...t.columns.values()],
      constraints: t.constraints.map(({ ref, ...c }): RawConstraint => {
        if (c.type !== "f" || ref === undefined) return c;
        const [refSchema = "", refTable = ""] = ref.split("\u0000");
        return { ...c, refSchema, refTable };
      }),
      indexes: [...this.indexes]
        .filter(([, v]) => v.table === key)
        .map(([name, v]) => ({ name, cols: v.cols, unique: v.unique, partial: v.partial })),
    }));
    const enums = [...this.enums].map(([key, e]) => {
      const [schema = "", name = ""] = key.split("\u0000");
      return { schema, name, doc: e.doc, values: e.values };
    });
    return { tables, enums };
  }
}

export function extractSql(path: string, exclude?: string | null): ErdModel {
  const files = sqlFiles(path);
  if (!files.length) throw new Error(`No .sql files found at ${path}`);
  const schema = new Schema();
  for (const p of files) {
    const text = readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
    for (const stmt of splitStatements(text)) schema.apply(stmt);
  }
  return finalize(schema.toRaw(), exclude);
}
