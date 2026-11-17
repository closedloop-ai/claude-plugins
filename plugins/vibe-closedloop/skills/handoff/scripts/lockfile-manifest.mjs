import path from "node:path";

const DEPENDENCY_FIELDS = new Set([
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
  "configDependencies", "packageManagerDependencies",
]);
const RESOLVED_DEPENDENCY_FIELDS = new Set(["dependencies", "optionalDependencies"]);
const PACKAGE_METADATA_FIELDS = new Map([
  ["resolution", "resolution"], ["engines", "mapping"], ["peerDependencies", "mapping"],
  ["peerDependenciesMeta", "peer-meta"], ["hasBin", "boolean"],
  ["cpu", "sequence"], ["libc", "sequence"], ["os", "sequence"], ["bundledDependencies", "sequence"],
  ["deprecated", "string"], ["version", "string"],
]);
const SNAPSHOT_METADATA_FIELDS = new Map([
  ["optional", "boolean"], ["transitivePeerDependencies", "sequence"],
]);
const YAML_NON_STRING = /^(?:true|false|null|~|[+-]?(?:\.inf|\.nan|0[b][01_]+|0[o][0-7_]+|0[x][\da-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?\d[\d_]*)?)|\d{4}-\d{2}-\d{2}(?:[Tt ].*)?)$/i;

/** Read the mapping shapes pnpm writes without accepting an unknown YAML structure as evidence. */
function mappingAt(lines, indent) {
  const entries = new Map();
  let current;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      if (current) current.lines.push(line);
      continue;
    }
    const spaces = /^ */.exec(line)[0].length;
    if (line.includes("\t") || spaces < indent) throw new Error("unexpected indentation");
    if (spaces === indent) {
      const key = mappingKey(line.slice(indent));
      if (key === null || entries.has(key)) throw new Error(`unrecognized or repeated mapping key at ${line.trim()}`);
      current = { key, lines: [line] };
      entries.set(key, current);
    } else if (current) {
      current.lines.push(line);
    } else {
      throw new Error("nested content without a mapping key");
    }
  }
  return entries;
}

function mappingKey(text) {
  const quoted = /^'((?:[^']|'')*)':(?:\s|$)/.exec(text);
  if (quoted) return quoted[1].replaceAll("''", "'");
  const double = /^"((?:[^"\\]|\\.)*)":(?:\s|$)/.exec(text);
  if (double) return JSON.parse(`"${double[1]}"`);
  return /^([^'"#].*?):(?:\s|$)/.exec(text)?.[1].trim() ?? null;
}

function parseLock(text) {
  const sections = mappingAt(text.split(/\r?\n/), 0);
  if (!sections.has("lockfileVersion") || !sections.has("importers")) throw new Error("missing pnpm lockfile sections");
  return {
    sections,
    importers: mappingAt(sections.get("importers").lines.slice(1), 2),
    packages: sections.has("packages") ? mappingAt(sections.get("packages").lines.slice(1), 2) : new Map(),
    snapshots: sections.has("snapshots") ? mappingAt(sections.get("snapshots").lines.slice(1), 2) : new Map(),
  };
}

function same(a, b) {
  return (a?.lines.join("\n").trimEnd() ?? null) === (b?.lines.join("\n").trimEnd() ?? null);
}

function supportedMappingHeader(block) {
  if (!block || !/:\s*(?:\{\})?\s*$/.test(block.lines[0])) return !block;
  if (!/:\s*\{\}\s*$/.test(block.lines[0])) return true;
  return block.lines.slice(1).every((line) => !line.trim() || line.trimStart().startsWith("#"));
}

function keysOf(a, b) {
  return [...new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])])].sort();
}

function nested(block, indent) {
  return block ? mappingAt(block.lines.slice(1), indent) : new Map();
}

function stringScalar(text) {
  const trimmed = text.trim();
  const single = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(trimmed);
  if (single) return single[1].replaceAll("''", "'");
  const double = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(trimmed);
  if (double) {
    try { return JSON.parse(double[1]); }
    catch { return null; }
  }
  const comment = trimmed.search(/(?:^|\s)#/);
  const value = (comment < 0 ? trimmed : trimmed.slice(0, comment)).trim();
  if (!value || /^[{\[|>!&*]/.test(value) || /:(?:\s|$)/.test(value) || YAML_NON_STRING.test(value)) return null;
  return value;
}

function unquotedYaml(text) {
  let output = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'" && text[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(text[index - 1]))) break;
    output += character;
  }
  return output;
}

function withoutYamlComment(text) {
  let output = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "'") {
      output += character;
      if (character === "'" && text[index + 1] === "'") output += text[index += 1];
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      output += character;
      if (character === "\\" && text[index + 1]) output += text[index += 1];
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    if (character === "#" && (index === 0 || /\s/.test(text[index - 1]))) break;
    output += character;
  }
  return output.trim();
}

function hasUnsupportedYamlReference(block) {
  return block.lines.some((line) => /(?:^|[\s:[{,])(?:\*|&|!{1,2})(?:[A-Za-z0-9_-]|<)/.test(unquotedYaml(line)));
}

function splitFlow(text, separator) {
  const parts = [];
  const stack = [];
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'" && text[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) return null;
    } else if (character === separator && stack.length === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || stack.length) return null;
  parts.push(text.slice(start));
  return parts;
}

function flowColon(text) {
  const parts = splitFlow(text, ":");
  if (!parts || parts.length < 2) return null;
  return [parts[0], text.slice(parts[0].length + 1)];
}

function validFlowValue(text) {
  const value = text.trim();
  if (value.startsWith("{")) return validFlowMap(value);
  if (value.startsWith("[")) return validFlowList(value);
  return stringScalar(value) !== null || /^(?:true|false|[+-]?(?:\d+(?:\.\d+)?|\.\d+))$/i.test(value);
}

function flowMapEntries(text) {
  const value = withoutYamlComment(text);
  if (!value.startsWith("{") || !value.endsWith("}") || hasUnsupportedYamlReference({ lines: [value] })) return false;
  const content = value.slice(1, -1).trim();
  if (!content) return [];
  const entries = splitFlow(content, ",");
  if (!entries) return null;
  const pairs = entries.map((entry) => {
    const pair = flowColon(entry);
    return pair && stringScalar(pair[0]) !== null && pair[1].trim() ? [stringScalar(pair[0]), pair[1].trim()] : null;
  });
  if (!pairs.every(Boolean)) return null;
  const keys = new Set();
  for (const [key] of pairs) {
    if (keys.has(key)) return null;
    keys.add(key);
  }
  return pairs;
}

function validFlowMap(text) {
  const entries = flowMapEntries(text);
  return Boolean(entries && entries.every(([_key, value]) => validFlowValue(value)));
}

function validFlowList(text) {
  const value = withoutYamlComment(text);
  if (!value.startsWith("[") || !value.endsWith("]") || hasUnsupportedYamlReference({ lines: [value] })) return false;
  const content = value.slice(1, -1).trim();
  if (!content) return true;
  const items = splitFlow(content, ",");
  return Boolean(items?.every((item) => validFlowValue(item)));
}

function validStringFlowList(text) {
  const value = withoutYamlComment(text);
  if (!value.startsWith("[") || !value.endsWith("]") || hasUnsupportedYamlReference({ lines: [value] })) return false;
  const content = value.slice(1, -1).trim();
  if (!content) return true;
  const items = splitFlow(content, ",");
  return Boolean(items?.every((item) => stringScalar(item) !== null));
}

function blockValue(block) {
  return block.lines[0].slice(block.lines[0].indexOf(":") + 1).trim();
}

function mappingEntries(block, indent) {
  const value = blockValue(block);
  if (value) {
    if (block.lines.slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#"))) return null;
    const entries = flowMapEntries(value);
    return entries ? new Map(entries.map(([key, raw]) => [key, { key, lines: [`${key}: ${raw}`] }])) : null;
  }
  try { return mappingAt(block.lines.slice(1), indent); }
  catch { return null; }
}

function validMapping(block, indent, valueValidator = (_key, value) => entryScalar(value) !== null) {
  const entries = mappingEntries(block, indent);
  return Boolean(entries?.size && [...entries].every(([key, entry]) => valueValidator(key, entry)));
}

function validBoolean(block) {
  if (block.lines.slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#"))) return false;
  const value = unquotedYaml(blockValue(block)).trim();
  return value === "true" || value === "false";
}

function validSequence(block, indent) {
  const value = blockValue(block);
  if (value) {
    if (block.lines.slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#"))) return false;
    return validStringFlowList(value);
  }
  const lines = block.lines.slice(1).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  return lines.length > 0 && lines.every((line) => {
    const spaces = /^ */.exec(line)[0].length;
    return spaces === indent && line.slice(indent).startsWith("- ") && stringScalar(line.slice(indent + 2)) !== null;
  });
}

function sequenceAt(lines, indent) {
  const items = [];
  let current;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      if (current) current.push(line);
      continue;
    }
    const spaces = /^ */.exec(line)[0].length;
    if (line.includes("\t") || spaces < indent) return null;
    if (spaces === indent) {
      if (!line.slice(indent).startsWith("- ")) return null;
      current = [line];
      items.push(current);
    } else if (current) {
      current.push(line);
    } else {
      return null;
    }
  }
  return items;
}

function validMappingLines(lines, indent) {
  let entries;
  try { entries = mappingAt(lines, indent); }
  catch { return false; }
  return entries.size > 0 && [...entries.values()].every((entry) => validNode(entry, indent + 2));
}

function validNode(block, indent) {
  const value = blockValue(block);
  if (value) {
    if (block.lines.slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#"))) return false;
    return validFlowValue(value);
  }
  const lines = block.lines.slice(1).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  if (lines.length === 0) return false;
  if (lines[0].slice(indent).startsWith("- ")) {
    const items = sequenceAt(block.lines.slice(1), indent);
    return Boolean(items?.length && items.every((item) => {
      const first = item[0].slice(indent + 2);
      if (mappingKey(first) !== null) {
        return validMappingLines([`${" ".repeat(indent + 2)}${first}`, ...item.slice(1)], indent + 2);
      }
      return item.slice(1).every((line) => !line.trim() || line.trimStart().startsWith("#")) && validFlowValue(first);
    }));
  }
  return validMappingLines(block.lines.slice(1), indent);
}

function validRevision(block) {
  if (block.lines.slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#"))) return false;
  const value = unquotedYaml(blockValue(block)).trim();
  return /^(?:0|[1-9]\d*)$/.test(value) && BigInt(value) <= 9_007_199_254_740_991n;
}

function unsignedValue(block, maximum) {
  if (block.lines.slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#"))) return null;
  const value = unquotedYaml(blockValue(block)).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value) || BigInt(value) > maximum) return null;
  return value;
}

function booleanValue(block) {
  return validBoolean(block) ? unquotedYaml(blockValue(block)).trim() === "true" : null;
}

function floorValue(block) {
  const value = entryScalar(block);
  if (!value || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/.test(value)) return null;
  return value.split(".").every((part) => BigInt(part) <= 4_294_967_295n) ? value : null;
}

function validTargets(block, indent) {
  if (blockValue(block)) return false;
  const items = sequenceAt(block.lines.slice(1), indent);
  return Boolean(items?.length && items.every((item) => {
    const first = item[0].slice(indent + 2);
    if (mappingKey(first) === null) return false;
    let entries;
    try { entries = mappingAt([`${" ".repeat(indent + 2)}${first}`, ...item.slice(1)], indent + 2); }
    catch { return false; }
    const keys = new Set(entries.keys());
    if ([...keys].some((key) => !["any", "os", "cpu", "libc", "libcVersion", "osVersion", "napi", "nodeAbi", "wasm32"].includes(key))) return false;
    const any = entries.has("any") ? booleanValue(entries.get("any")) : false;
    const wasm32 = entries.has("wasm32") ? booleanValue(entries.get("wasm32")) : false;
    if (any === null || wasm32 === null) return false;
    if (any && (keys.size !== 1 || wasm32)) return false;
    if (!any && !wasm32 && (!keys.has("os") || !keys.has("cpu"))) return false;
    if (wasm32 && (keys.has("os") || keys.has("cpu"))) return false;
    for (const key of ["os", "cpu", "libc"]) {
      if (entries.has(key) && entryScalar(entries.get(key)) === null) return false;
    }
    for (const key of ["libcVersion", "osVersion"]) {
      if (entries.has(key) && floorValue(entries.get(key)) === null) return false;
    }
    if (entries.has("napi") && unsignedValue(entries.get("napi"), 4_294_967_295n) === null) return false;
    if (entries.has("nodeAbi") && !/^(?:node|electron)-(?:0|[1-9]\d*)$/.test(entryScalar(entries.get("nodeAbi")) ?? "")) return false;
    return true;
  }));
}

function validVariants(block, indent) {
  if (blockValue(block)) return false;
  const items = sequenceAt(block.lines.slice(1), indent);
  return Boolean(items?.length && items.every((item) => {
    const first = item[0].slice(indent + 2);
    if (mappingKey(first) === null) return false;
    let entries;
    try { entries = mappingAt([`${" ".repeat(indent + 2)}${first}`, ...item.slice(1)], indent + 2); }
    catch { return false; }
    if (entries.size !== 2 || !entries.has("resolution") || !entries.has("targets")) return false;
    return validResolution(entries.get("resolution"), indent + 4) && validTargets(entries.get("targets"), indent + 4);
  }));
}

function validResolution(block, indent = 6) {
  const entries = mappingEntries(block, indent);
  if (!entries?.size) return false;
  for (const [key, entry] of entries) {
    if (key === "revision") {
      if (!validRevision(entry)) return false;
      continue;
    }
    if (key === "gitHosted") {
      if (!validBoolean(entry)) return false;
      continue;
    }
    if (["integrity", "tarball", "directory", "commit", "repo", "path", "type", "url", "archive"].includes(key)) {
      if (entryScalar(entry) === null) return false;
      continue;
    }
    if (key === "bin") {
      if (entryScalar(entry) === null && !validMapping(entry, indent + 2)) return false;
      continue;
    }
    if (key === "variants") {
      if (!validVariants(entry, indent + 2)) return false;
      continue;
    }
    return false;
  }
  const type = entries.has("type") ? entryScalar(entries.get("type")) : null;
  return type === "variations" ? entries.has("variants") : !entries.has("variants");
}

function validMetadata(section, field, block) {
  const kind = (section === "packages" ? PACKAGE_METADATA_FIELDS : SNAPSHOT_METADATA_FIELDS).get(field);
  if (kind === "resolution") return validResolution(block);
  if (kind === "mapping") return validMapping(block, 6);
  if (kind === "peer-meta") return validMapping(block, 6, (_name, entry) =>
    validMapping(entry, 8, (key, value) => key === "optional" && validBoolean(value)));
  if (kind === "boolean") return validBoolean(block);
  if (kind === "sequence") return validSequence(block, 6);
  if (kind === "string") return entryScalar(block) !== null;
  return false;
}

function scalar(block, key, indent) {
  const line = block?.lines.find((item) => /^ */.exec(item)[0].length === indent && mappingKey(item.slice(indent)) === key);
  if (!line) return null;
  return stringScalar(line.slice(line.indexOf(":") + 1));
}

function entryScalar(block) {
  if (!block || block.lines.slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#"))) return null;
  return stringScalar(block.lines[0].slice(block.lines[0].indexOf(":") + 1));
}

function manifestDependencies(text) {
  const manifest = text === null ? {} : JSON.parse(text);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest must be an object");
  return Object.fromEntries([...DEPENDENCY_FIELDS].map((field) => {
    const dependencies = Object.hasOwn(manifest, field) ? manifest[field] : {};
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies) ||
        Object.values(dependencies).some((specifier) => typeof specifier !== "string")) {
      throw new Error(`${field} must be a string map`);
    }
    return [field, dependencies];
  }));
}

function importerForManifest(file) {
  const directory = path.posix.dirname(file);
  return directory === "." ? "." : directory;
}

/** A pnpm importer dependency has exactly two scalar fields; unknown fields cannot grant permission. */
function importerDependency(block) {
  if (!block) return null;
  try {
    const fields = nested(block, 8);
    if (fields.size !== 2 || !fields.has("specifier") || !fields.has("version") ||
        [...fields.values()].some((field) => field.lines.slice(1).some((line) => line.trim() && !line.trimStart().startsWith("#")))) return null;
    const specifier = scalar(block, "specifier", 8);
    const version = scalar(block, "version", 8);
    if (!specifier || !version) return null;
    return { specifier, version };
  } catch {
    return null;
  }
}

/** Resolve an npm alias from its manifest specifier and importer target version. */
function rootReference(name, entry) {
  if (!entry) return null;
  if (!entry.specifier.startsWith("npm:")) return { name, version: entry.version };
  const target = entry.specifier.slice("npm:".length);
  const separator = target.lastIndexOf("@");
  if (separator < 1) return null;
  const targetName = target.slice(0, separator);
  const resolved = entry.version.replace(/^npm:/, "");
  const prefix = `${targetName}@`;
  return resolved.startsWith(prefix) && resolved.length > prefix.length
    ? { name: targetName, version: resolved.slice(prefix.length) } : null;
}

function aliasedReference(name, version) {
  const target = /^((?:@[^/]+\/)?[^/@(]+)@(.+)$/.exec(version.replace(/^npm:/, ""));
  return target ? { name: target[1], version: target[2] } : { name, version };
}

function resolvedRefs(block) {
  const refs = [];
  for (const [field, category] of nested(block, 4)) {
    if (!RESOLVED_DEPENDENCY_FIELDS.has(field)) continue;
    for (const [name, dep] of nested(category, 6)) {
      const value = entryScalar(dep);
      if (!value) throw new Error("unsupported resolved dependency scalar");
      if (value && !value.startsWith("link:") && !value.startsWith("file:")) refs.push(aliasedReference(name, value));
    }
  }
  return refs;
}

function resolvedBodyParts(block, section) {
  try {
    if (hasUnsupportedYamlReference(block)) return null;
    const edges = [];
    const metadata = [];
    for (const [field, category] of nested(block, 4)) {
      const text = category.lines.join("\n").trimEnd();
      if (RESOLVED_DEPENDENCY_FIELDS.has(field)) {
        if (!supportedMappingHeader(category)) return null;
        if ([...nested(category, 6).values()].some((dependency) => !entryScalar(dependency))) return null;
        edges.push(text);
      } else {
        if (!validMetadata(section, field, category)) return null;
        metadata.push(text);
      }
    }
    return { edges: JSON.stringify(edges.sort()), metadata: JSON.stringify(metadata.sort()) };
  } catch {
    return null;
  }
}

function resolvedKeys(lock, ref) {
  const exact = `${ref.name}@${ref.version}`;
  const unpeered = `${ref.name}@${ref.version.split("(")[0]}`;
  return [
    ...(lock.snapshots.has(exact) ? [["snapshots", exact]] : []),
    ...(lock.packages.has(unpeered) ? [["packages", unpeered]] : []),
  ];
}

function reachable(lock, roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    for (const [section, key] of resolvedKeys(lock, queue.shift())) {
      const id = `${section}/${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      try { queue.push(...resolvedRefs(lock[section].get(key))); }
      catch { /* The changed entry is named by resolvedBodyParts below. */ }
    }
  }
  return seen;
}

/** Name every lockfile entry whose change is not attributable to an admitted manifest dependency edit. */
export function unexplainedLockfileEntries({ before, after, manifests }) {
  if (before === null || after === null) return ["pnpm-lock.yaml (added or removed)"];
  const documents = (text) => text.split(/^---\s*$/m).filter((part) => part.trim());
  const oldDocuments = documents(before);
  const newDocuments = documents(after);
  if (oldDocuments.length !== newDocuments.length) return ["pnpm-lock.yaml (document count changed)"];
  return [...new Set(oldDocuments.flatMap((text, index) => {
    try {
      return unexplainedDocumentEntries({ before: text, after: newDocuments[index], manifests });
    } catch (error) {
      return [`pnpm-lock.yaml (${error.message})`];
    }
  }))].sort();
}

function unexplainedDocumentEntries({ before, after, manifests }) {
  let oldLock;
  let newLock;
  try {
    oldLock = parseLock(before);
    newLock = parseLock(after);
  } catch (error) {
    return [`pnpm-lock.yaml (${error.message})`];
  }
  const unexplained = [];
  const changedDependencies = new Map();
  for (const { file, before: oldText, after: newText } of manifests) {
    try {
      const oldDeps = manifestDependencies(oldText);
      const newDeps = manifestDependencies(newText);
      const changes = changedDependencies.get(importerForManifest(file)) ?? new Map();
      for (const field of DEPENDENCY_FIELDS) {
        for (const name of keysOf(new Map(Object.entries(oldDeps[field])), new Map(Object.entries(newDeps[field])))) {
          const before = Object.hasOwn(oldDeps[field], name) ? oldDeps[field][name] : null;
          const after = Object.hasOwn(newDeps[field], name) ? newDeps[field][name] : null;
          if (before !== after) changes.set(`${field}/${name}`, {
            before, after,
          });
        }
      }
      changedDependencies.set(importerForManifest(file), changes);
    } catch {
      // An unreadable manifest cannot grant lockfile permission.
    }
  }

  const oldRoots = [];
  const newRoots = [];
  for (const importer of keysOf(oldLock.importers, newLock.importers)) {
    const oldImporter = oldLock.importers.get(importer);
    const newImporter = newLock.importers.get(importer);
    const importerAddedOrRemoved = oldLock.importers.has(importer) !== newLock.importers.has(importer);
    let matchedDependencyChange = false;
    let oldCategories;
    let newCategories;
    try {
      oldCategories = nested(oldImporter, 4);
      newCategories = nested(newImporter, 4);
    } catch {
      unexplained.push(`importers/${importer}`);
      continue;
    }
    const changedCategories = keysOf(oldCategories, newCategories).filter((field) =>
      !same(oldCategories.get(field), newCategories.get(field)));
    for (const field of changedCategories) {
      const oldCategory = oldCategories.get(field);
      const newCategory = newCategories.get(field);
      if (!DEPENDENCY_FIELDS.has(field)) {
        unexplained.push(`importers/${importer}/${field}`);
        continue;
      }
      let oldEntries;
      let newEntries;
      try {
        oldEntries = nested(oldCategory, 6);
        newEntries = nested(newCategory, 6);
      } catch {
        unexplained.push(`importers/${importer}/${field}`);
        continue;
      }
      const changedEntries = keysOf(oldEntries, newEntries).filter((name) =>
        !same(oldEntries.get(name), newEntries.get(name)));
      const canonicalHeader = (category) => !category ||
        ([`${field}:`, `${field}: {}`].includes(category.lines[0].trim()) && supportedMappingHeader(category));
      if (!canonicalHeader(oldCategory) || !canonicalHeader(newCategory)) {
        unexplained.push(`importers/${importer}/${field}`);
      }
      for (const name of changedEntries) {
        const oldEntry = oldEntries.get(name);
        const newEntry = newEntries.get(name);
        const change = changedDependencies.get(importer)?.get(`${field}/${name}`);
        const oldDependency = importerDependency(oldEntry);
        const newDependency = importerDependency(newEntry);
        const oldRoot = rootReference(name, oldDependency);
        const newRoot = rootReference(name, newDependency);
        if (!change || (oldDependency?.specifier ?? null) !== change.before ||
            (newDependency?.specifier ?? null) !== change.after ||
            (oldEntry && !oldRoot) || (newEntry && !newRoot)) {
          unexplained.push(`importers/${importer}/${field}/${name}`);
          continue;
        }
        matchedDependencyChange = true;
        if (oldRoot) oldRoots.push(oldRoot);
        if (newRoot) newRoots.push(newRoot);
      }
      if (changedEntries.length === 0) unexplained.push(`importers/${importer}/${field}`);
    }
    if (importerAddedOrRemoved && !matchedDependencyChange) unexplained.push(`importers/${importer}`);
    if (!supportedMappingHeader(oldImporter) || !supportedMappingHeader(newImporter) ||
        oldImporter?.lines[0] !== newImporter?.lines[0] && changedCategories.length === 0) {
      unexplained.push(`importers/${importer}`);
    }
  }

  const explainedResolved = new Set([...reachable(oldLock, oldRoots), ...reachable(newLock, newRoots)]);
  for (const section of ["packages", "snapshots"]) {
    for (const key of keysOf(oldLock[section], newLock[section])) {
      const oldEntry = oldLock[section].get(key);
      const newEntry = newLock[section].get(key);
      if (!same(oldEntry, newEntry)) {
        const oldParts = oldEntry ? resolvedBodyParts(oldEntry, section) : null;
        const newParts = newEntry ? resolvedBodyParts(newEntry, section) : null;
        const sameKeyUnexplained = oldEntry && newEntry &&
          (oldParts?.metadata !== newParts?.metadata || oldParts?.edges === newParts?.edges);
        if (!supportedMappingHeader(oldEntry) || !supportedMappingHeader(newEntry) ||
            oldEntry && !oldParts || newEntry && !newParts ||
            !explainedResolved.has(`${section}/${key}`) || sameKeyUnexplained) {
          unexplained.push(`${section}/${key}`);
        }
      }
    }
  }
  for (const section of ["importers", "packages", "snapshots"]) {
    const oldBlock = oldLock.sections.get(section);
    const newBlock = newLock.sections.get(section);
    const changedEntries = keysOf(oldLock[section], newLock[section]).filter((key) =>
      !same(oldLock[section].get(key), newLock[section].get(key)));
    if (!supportedMappingHeader(oldBlock) || !supportedMappingHeader(newBlock) ||
        oldBlock?.lines[0] !== newBlock?.lines[0] && changedEntries.length === 0) {
      unexplained.push(section);
    }
  }
  for (const key of keysOf(oldLock.sections, newLock.sections)) {
    if (!["importers", "packages", "snapshots"].includes(key) && !same(oldLock.sections.get(key), newLock.sections.get(key))) {
      unexplained.push(key);
    }
  }
  return [...new Set(unexplained)].sort();
}
