/**
 * Domain maps: hub detection, an automatic first draft, and merging on update.
 *
 * A domain map is a list of {id, name, tables}. The draft clusters the FK graph
 * (hubs removed) with greedy modularity, then folds tiny clusters into a group
 * that shares their leading name token. It is a starting point for a human or
 * agent to rename and regroup, never the final word.
 */
import { byString, type ErdModel } from "./model.js";

export interface Domain {
  id: string;
  name: string;
  tables: string[];
}

const SMALL_SCHEMA = 20;
const CAMEL_WORDS_RE = /[A-Z]+(?=[A-Z][a-z]|$)|[A-Z][a-z0-9]*|[a-z0-9]+/g;
const CASED_RE = /\p{Lu}|\p{Ll}|\p{Lt}/u;
const DOMAIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Tables referenced by so many others that they would dominate a layout. */
export function hubs(model: ErdModel): string[] {
  const n = model.models.length;
  const incoming = new Map<string, Set<string>>();
  for (const r of model.relations) {
    if (r.parent === r.child) continue;
    let kids = incoming.get(r.parent);
    if (!kids) {
      kids = new Set();
      incoming.set(r.parent, kids);
    }
    kids.add(r.child);
  }
  const threshold = Math.max(10, 0.2 * n);
  return [...incoming]
    .filter(([, kids]) => kids.size >= threshold)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([t]) => t);
}

/** Python str.islower(): every cased character is lowercase and there is at least one. */
function isLower(s: string): boolean {
  let cased = false;
  for (const ch of s) {
    if (!CASED_RE.test(ch)) continue;
    if (ch !== ch.toLowerCase() || ch === ch.toUpperCase()) return false;
    cased = true;
  }
  return cased;
}

/** Python str.title(): uppercase a letter that follows an uncased character, lowercase the rest. */
function titleCase(s: string): string {
  let out = "";
  let prevCased = false;
  for (const ch of s) {
    const cased = CASED_RE.test(ch);
    if (cased) out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
    else out += ch;
    prevCased = cased;
  }
  return out;
}

export function words(fullName: string): string[] {
  const name = fullName.split(":").at(-1) ?? fullName;
  if (name.includes("_") || isLower(name)) return name.split("_").filter(Boolean);
  const found = name.match(CAMEL_WORDS_RE);
  return found?.length ? found : [name];
}

function leadToken(name: string): string {
  return (words(name)[0] ?? name).toLowerCase();
}

interface Prefix {
  parts: string[];
  count: number;
}

function prefixCounts(tables: string[]): Map<string, Prefix> {
  const counts = new Map<string, Prefix>();
  for (const t of tables) {
    const w = words(t);
    for (let k = 1; k <= Math.min(w.length, 3); k++) {
      const parts = w.slice(0, k);
      const key = parts.join("\u0000");
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { parts, count: 1 });
    }
  }
  return counts;
}

/** The longest name prefix (in whole words) shared by most of the group. */
export function labelFor(tables: string[], taken: Set<string>): string {
  const snake = tables.some((t) => t.includes("_") || isLower(t));
  const joiner = snake ? " " : "";
  const counts = [...prefixCounts(tables).values()];
  if (!counts.length) return "Group";
  const ranked = [...counts].sort((a, b) => b.count - a.count || b.parts.length - a.parts.length);
  const top = ranked[0]?.count ?? 0;
  const good = counts.filter((p) => p.count >= Math.max(2, 0.8 * top));
  const options = (good.length ? good : ranked.slice(0, 1)).sort(
    (a, b) => b.parts.length - a.parts.length || b.count - a.count,
  );
  options.push(...ranked.filter((p) => !options.includes(p)));
  for (const prefix of options) {
    const joined = prefix.parts.join(joiner);
    const text = snake ? titleCase(joined) : joined;
    if (!taken.has(text.toLowerCase())) return text;
  }
  const base = options[0]?.parts.join(joiner) ?? "Group";
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "group"
  );
}

function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

function comparePairs(a: [string, number], b: [string, number]): number {
  return byString(a[0], b[0]);
}

/** Greedy modularity agglomeration (Clauset-Newman-Moore, naive form). */
export function communities(nodes: string[], edges: Array<[string, string]>): string[][] {
  const adj = new Map<string, Map<string, number>>(nodes.map((v) => [v, new Map()]));
  const neighbors = (v: string): Map<string, number> => {
    let m = adj.get(v);
    if (!m) {
      m = new Map();
      adj.set(v, m);
    }
    return m;
  };
  for (const [a, b] of edges) {
    if (a === b) continue;
    neighbors(a).set(b, (neighbors(a).get(b) ?? 0) + 1);
    neighbors(b).set(a, (neighbors(b).get(a) ?? 0) + 1);
  }
  let m2 = 0;
  for (const c of adj.values()) for (const w of c.values()) m2 += w;
  const comm = new Map(nodes.map((v) => [v, new Set([v])]));
  if (!m2) return [...comm.values()].map((c) => [...c].sort(byString));
  const owner = new Map(nodes.map((v) => [v, v]));
  const tot = new Map<string, number>();
  for (const v of nodes) {
    let d = 0;
    for (const w of neighbors(v).values()) d += w;
    tot.set(v, d);
  }
  for (;;) {
    const between = new Map<string, number>();
    for (const a of nodes) {
      for (const [b, w] of neighbors(a)) {
        const ca = owner.get(a) ?? a;
        const cb = owner.get(b) ?? b;
        if (ca < cb) between.set(pairKey(ca, cb), (between.get(pairKey(ca, cb)) ?? 0) + w);
      }
    }
    let best = 0;
    let pair: [string, string] | null = null;
    for (const [key, w] of [...between].sort(comparePairs)) {
      const [ca = "", cb = ""] = key.split("\u0000");
      const gain = 2 * (w / m2 - ((tot.get(ca) ?? 0) * (tot.get(cb) ?? 0)) / (m2 * m2));
      if (gain > best + 1e-12) {
        best = gain;
        pair = [ca, cb];
      }
    }
    if (!pair) break;
    const [ca, cb] = pair;
    const merged = comm.get(cb) ?? new Set<string>();
    for (const v of merged) owner.set(v, ca);
    const target = comm.get(ca);
    if (target) for (const v of merged) target.add(v);
    comm.delete(cb);
    tot.set(ca, (tot.get(ca) ?? 0) + (tot.get(cb) ?? 0));
    tot.delete(cb);
  }
  return [...comm.values()].map((c) => [...c].sort(byString));
}

/** Attach each small-cluster table to the big cluster most of whose tables share its lead token. */
function foldSmall(big: string[][], small: string[]): string[] {
  const byToken = new Map<string, Array<[number, string[]]>>();
  for (const g of big) {
    const tokenCounts = new Map<string, number>();
    for (const t of g) tokenCounts.set(leadToken(t), (tokenCounts.get(leadToken(t)) ?? 0) + 1);
    for (const [tok, count] of tokenCounts) {
      const homes = byToken.get(tok) ?? [];
      homes.push([count, g]);
      byToken.set(tok, homes);
    }
  }
  const leftovers: string[] = [];
  for (const t of small) {
    const homes = byToken.get(leadToken(t));
    if (!homes?.length) {
      leftovers.push(t);
      continue;
    }
    let best = homes[0];
    for (const h of homes) if (best && h[0] > best[0]) best = h;
    best?.[1].push(t);
  }
  return leftovers;
}

export function draft(model: ErdModel): Domain[] {
  const names = model.models.map((m) => m.name);
  if (names.length <= SMALL_SCHEMA) return [{ id: "all", name: "All tables", tables: [...names].sort(byString) }];
  const hubSet = new Set(hubs(model));
  const rest = names.filter((n) => !hubSet.has(n));
  const edges = model.relations
    .filter((r) => !hubSet.has(r.parent) && !hubSet.has(r.child))
    .map((r): [string, string] => [r.parent, r.child]);
  const groups = communities(rest, edges);
  const big = groups.filter((g) => g.length >= 3);
  const small = groups.filter((g) => g.length < 3).flat();
  const leftovers = foldSmall(big, small);

  const tokenGroups = new Map<string, string[]>();
  for (const t of leftovers) {
    const tok = leadToken(t);
    tokenGroups.set(tok, [...(tokenGroups.get(tok) ?? []), t]);
  }
  const other: string[] = [];
  for (const ts of tokenGroups.values()) {
    if (ts.length >= 3) big.push(ts);
    else other.push(...ts);
  }

  const domains: Domain[] = [];
  const used = new Set<string>();
  if (hubSet.size) {
    domains.push({ id: "core", name: "Core", tables: [...hubSet].sort(byString) });
    used.add("core");
  }
  const ordered = [...big].sort((a, b) => b.length - a.length || byString(a[0] ?? "", b[0] ?? ""));
  for (const g of ordered) {
    const label = labelFor(g, new Set(domains.map((d) => d.name.toLowerCase())));
    let ident = slug(label);
    let k = 2;
    while (used.has(ident)) {
      ident = `${slug(label)}-${k}`;
      k++;
    }
    used.add(ident);
    domains.push({ id: ident, name: label, tables: [...g].sort(byString) });
  }
  if (other.length) domains.push({ id: "other", name: "Other", tables: [...other].sort(byString) });
  return domains;
}

/** Keep an existing map, drop tables that no longer exist, report new ones. */
export function merge(existing: Domain[], model: ErdModel): { domains: Domain[]; added: string[]; removed: string[] } {
  const current = new Set(model.models.map((m) => m.name));
  const out: Domain[] = [];
  const placed = new Set<string>();
  for (const d of existing) {
    if (d.id === "unsorted") continue;
    const tables = d.tables.filter((t) => current.has(t) && !placed.has(t));
    for (const t of tables) placed.add(t);
    out.push({ id: d.id, name: d.name, tables });
  }
  const everListed = new Set(existing.flatMap((d) => d.tables));
  const removed = [...everListed].filter((t) => !current.has(t)).sort(byString);
  const added = [...current].filter((t) => !placed.has(t)).sort(byString);
  return { domains: out.filter((d) => d.tables.length), added, removed };
}

function isDomainShape(d: unknown): d is Domain {
  if (typeof d !== "object" || d === null) return false;
  const r = d as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.name === "string" && Array.isArray(r.tables);
}

export function validateDomains(domains: unknown, model: ErdModel): string[] {
  if (!Array.isArray(domains) || !domains.length) return ["domain map must be a non-empty list of {id, name, tables}"];
  const problems: string[] = [];
  const names = new Set(model.models.map((m) => m.name));
  const ids = new Set<string>();
  const seen = new Map<string, string>();
  domains.forEach((d: unknown, i) => {
    if (!isDomainShape(d)) {
      problems.push(`domains[${i}] needs string id, string name and a tables list`);
      return;
    }
    if (!DOMAIN_ID_RE.test(d.id)) problems.push(`domains[${i}].id "${d.id}" must be lowercase letters, digits and dashes`);
    if (ids.has(d.id)) problems.push(`duplicate domain id "${d.id}"`);
    ids.add(d.id);
    for (const t of d.tables) {
      const where = seen.get(t);
      if (!names.has(t)) problems.push(`domain "${d.id}" lists "${t}", which is not a table in the schema`);
      else if (where !== undefined) problems.push(`"${t}" is in both "${where}" and "${d.id}"`);
      else seen.set(t, d.id);
    }
  });
  return problems;
}
