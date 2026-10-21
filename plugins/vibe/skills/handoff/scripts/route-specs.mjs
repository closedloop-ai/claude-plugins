// The route rule: the e2e specs a changed API route needs run. A spec is
// required when it names the endpoint, or imports a helper export that reaches
// it: an export whose declaration names the endpoint, or references a constant,
// function or import that does, followed across re-exports up to
// ROUTE_SPEC_HOPS files. An import the symbol walk cannot follow (namespace,
// dynamic, a default with no default declaration, a file it cannot split)
// falls back to file level, and the reason is printed with the spec.

import { isE2ePath, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { moduleShape } from "./module-symbols.mjs";
import { escapeRegExp, IMPORT_SPECIFIER, resolveImport, SOURCE_FILE } from "./source-imports.mjs";

const API_ROUTE = /^apps\/api\/app\/(.*)\/route\.ts$/;
const ROUTE_SPEC_HOPS = 3;
const PASS_LIMIT = 50;
const RUNS = "specs pin request bodies and untagged specs do not run on the pull request";

/** Required specs for every changed API route in `files`, each with its reason. */
export function routeSpecs(files, repo) {
  const routes = files.flatMap((file) => {
    const match = API_ROUTE.exec(file.path);
    return match ? [{ route: file.path, pattern: endpointPattern(match[1]) }] : [];
  });
  if (routes.length === 0) {
    return [];
  }
  const e2eFiles = repo.headFiles.filter((file) => isE2ePath(file) && SOURCE_FILE.test(file));
  const importers = e2eImporters(e2eFiles, repo);
  const required = new Map();
  for (const { route, pattern } of routes) {
    const named = e2eFiles.filter((candidate) => pattern.test(repo.head(candidate) ?? ""));
    for (const [spec, { prefix, suffix }] of specsForEndpoint(named, pattern, importers, repo)) {
      if (!required.has(spec)) {
        required.set(spec, { path: spec, reason: `${prefix} the changed endpoint in ${route}${suffix}; ${RUNS}` });
      }
    }
  }
  return [...required.values()];
}

function endpointPattern(routeDirectory) {
  const segments = routeDirectory.split("/").filter((segment) => !/^\(.*\)$/.test(segment));
  return new RegExp(`/${segments.map((segment) => (/^\[.*\]$/.test(segment) ? "[^/\"'`?\\s]+" : escapeRegExp(segment))).join("/")}(?![\\w-])`);
}

/** Each e2e file mapped to the e2e files that import it. */
function e2eImporters(e2eFiles, repo) {
  const known = new Set(e2eFiles);
  const importers = new Map();
  for (const file of e2eFiles) {
    for (const found of (repo.head(file) ?? "").matchAll(IMPORT_SPECIFIER)) {
      const target = resolveImport(file, found[1], known);
      if (target && target !== file) {
        importers.set(target, (importers.get(target) ?? new Set()).add(file));
      }
    }
  }
  return importers;
}

/** Files that name the endpoint or import one that does, within ROUTE_SPEC_HOPS; the walk stops at a spec. */
function candidateFiles(named, importers) {
  const seen = new Set(named);
  let frontier = named.filter((file) => !TEST_SPEC_PATTERN.test(file));
  for (let hops = 1; frontier.length && hops <= ROUTE_SPEC_HOPS; hops += 1) {
    const next = [];
    for (const importer of frontier.flatMap((file) => [...(importers.get(file) ?? [])])) {
      if (!seen.has(importer)) {
        seen.add(importer);
        if (!TEST_SPEC_PATTERN.test(importer)) {
          next.push(importer);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Spec path to the `{ prefix, suffix }` around "the changed endpoint in <route>", for one endpoint. */
function specsForEndpoint(named, pattern, importers, repo) {
  const candidates = candidateFiles(named, importers);
  const shapes = new Map([...candidates].map((file) => [file, moduleShape(repo.head(file) ?? "", (specifier) => resolveImport(file, specifier, candidates))]));
  const taint = taintExports(shapes, pattern);
  const specs = new Map();
  for (const [file, shape] of shapes) {
    if (TEST_SPEC_PATTERN.test(file)) {
      const reason = specReason(file, shape, pattern, taint);
      if (reason) {
        specs.set(file, reason);
      }
    }
  }
  return specs;
}

/**
 * Fixed point of which exports reach the endpoint. A taint is
 * `{ depth, origin, fallback }`: files crossed since `origin` named it, and why
 * the walk used file level, if it did. `any` is the nearest taint of a file
 * (what a namespace or dynamic import sees); `onImport` is taint that running
 * the file at all reaches (a top-level statement, or a file it cannot split).
 */
function taintExports(shapes, pattern) {
  const exports = new Map([...shapes.keys()].map((file) => [file, new Map()]));
  const any = new Map();
  const onImport = new Map();
  const better = (current, candidate) => candidate && candidate.depth <= ROUTE_SPEC_HOPS && (!current || candidate.depth < current.depth);
  const step = (found, fallback) => found && { depth: found.depth + 1, origin: found.origin, fallback: fallback ?? found.fallback };
  const exportOf = (target, name) => {
    const shape = shapes.get(target);
    if (shape?.ok && name === "default" && !shape.exports.has("default")) {
      const found = any.get(target);
      return found && { ...found, fallback: `file-level fallback: default import of ${target}, which declares no default export` };
    }
    return exports.get(target)?.get(name) ?? onImport.get(target);
  };
  const context = { pattern, exports, any, onImport, better, step, exportOf };
  for (let pass = 0, changed = true; changed && pass < PASS_LIMIT; pass += 1) {
    changed = false;
    for (const [file, shape] of shapes) {
      const found = fileTaint(file, shape, context);
      for (const [name, value] of found.exports) {
        if (better(exports.get(file).get(name), value)) {
          exports.get(file).set(name, value);
          changed = true;
        }
      }
      for (const [map, value] of [[onImport, found.onImport], [any, found.any]]) {
        if (better(map.get(file), value)) {
          map.set(file, value);
          changed = true;
        }
      }
    }
  }
  return { exportOf, any, onImport, step };
}

/** One file's export taints given the current taints of the files it imports. */
function fileTaint(file, shape, { pattern, exports, any, onImport, better, step, exportOf }) {
  const result = { exports: new Map(), onImport: null, any: null };
  const keep = (key, value) => {
    if (better(result[key], value)) {
      result[key] = value;
    }
  };
  if (!shape.ok) {
    const reason = `file-level fallback: ${file} could not be split into statements (${shape.reason})`;
    keep("onImport", pattern.test(shape.text) ? { depth: 0, origin: file, fallback: reason } : null);
    for (const target of shape.unsplitImports) {
      keep("onImport", step(any.get(target), reason));
    }
    keep("any", result.onImport);
    return result;
  }
  const locals = new Map();
  const binding = (name) => {
    if (locals.has(name)) {
      return locals.get(name);
    }
    const imported = shape.imports.get(name);
    if (imported) {
      return step(exportOf(imported.target, imported.name));
    }
    const namespace = shape.namespaces.get(name);
    return namespace ? step(any.get(namespace), `file-level fallback: namespace import of ${namespace}`) : null;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const statement of shape.statements) {
      let found = pattern.test(statement.code) ? { depth: 0, origin: file, fallback: null } : null;
      for (const ref of statement.refs) {
        const value = binding(ref);
        found = better(found, value) ? value : found;
      }
      for (const target of statement.dynamic) {
        const value = step(any.get(target), `file-level fallback: dynamic import of ${target}`);
        found = better(found, value) ? value : found;
      }
      if (!found) {
        continue;
      }
      if (statement.names.length === 0) {
        keep("onImport", found);
      }
      for (const name of statement.names) {
        if (better(locals.get(name), found)) {
          locals.set(name, found);
          changed = true;
        }
      }
    }
  }
  for (const { target, how } of shape.fileImports) {
    keep("onImport", step(how === "dynamic import" ? any.get(target) : onImport.get(target), `file-level fallback: ${how} of ${target}`));
  }
  for (const [name, entry] of shape.exports) {
    const value = exportValue(entry, locals, { any, step, exportOf });
    if (better(result.exports.get(name), value)) {
      result.exports.set(name, value);
    }
  }
  for (const target of shape.stars) {
    for (const [name, value] of exports.get(target) ?? []) {
      if (name !== "default" && better(result.exports.get(name), step(value))) {
        result.exports.set(name, step(value));
      }
    }
  }
  keep("any", result.onImport);
  for (const value of result.exports.values()) {
    keep("any", value);
  }
  return result;
}

function exportValue(entry, locals, { any, step, exportOf }) {
  if (entry.local !== undefined) {
    return locals.get(entry.local) ?? null;
  }
  if (entry.namespace !== undefined) {
    return step(any.get(entry.namespace), `file-level fallback: namespace re-export of ${entry.namespace}`);
  }
  return step(exportOf(entry.target, entry.name));
}

/** Why a spec is required, or null: it names the endpoint, or one of its imports reaches it. */
function specReason(file, shape, pattern, taint) {
  if (shape.ok ? shape.statements.some((statement) => pattern.test(statement.code)) : pattern.test(shape.text)) {
    return { prefix: "names", suffix: "" };
  }
  if (!shape.ok) {
    const via = `file-level fallback: ${file} could not be split into statements (${shape.reason})`;
    return shape.unsplitImports.map((target) => importReason(taint.any.get(target), via)).filter(Boolean)
      .sort((left, right) => left.depth - right.depth)[0]?.text ?? null;
  }
  const reasons = [];
  for (const [local, { target, name }] of shape.imports) {
    reasons.push(importReason(taint.exportOf(target, name), `imports ${name === local ? name : `${name} as ${local}`} from ${target}`));
  }
  for (const target of shape.namespaces.values()) {
    reasons.push(importReason(taint.any.get(target), `file-level fallback: namespace import of ${target}`));
  }
  for (const { target, how } of shape.fileImports) {
    const found = how === "dynamic import" ? taint.any.get(target) : taint.onImport.get(target);
    reasons.push(importReason(found, `file-level fallback: ${how} of ${target}`));
  }
  return reasons.filter(Boolean).sort((left, right) => left.depth - right.depth)[0]?.text ?? null;
}

function importReason(found, via) {
  if (!found || found.depth + 1 > ROUTE_SPEC_HOPS) {
    return null;
  }
  const hops = found.depth + 1;
  const fallback = found.fallback && !via.startsWith("file-level") ? ` (${found.fallback})` : "";
  const origin = hops > 1 ? ` (named in ${found.origin}, ${hops} imports away)` : "";
  return { depth: found.depth, text: { prefix: `${via}${fallback}, which reaches`, suffix: origin } };
}
