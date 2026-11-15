// Import resolution shared by the diff rules: the frozen-story render closure
// and the route rule's e2e import graph. Text reads only.

import path from "node:path";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");

export const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot)$/;
export const IMPORT_SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const STYLESHEET = /\.(?:css|scss|sass|less)$/i;
const SASS_SOURCE = /\.(?:scss|sass)$/i;
const IMPORT_SOURCE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less)$/i;
const IDENTIFIER = /[\w$]/;
const CLOSURE_LIMIT = 20000;
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".css", ".scss", ".sass", ".less", ".json", ".svg",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot", "/index.ts", "/index.tsx"];

function quoted(source, start) {
  const quote = source[start];
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      if (index + 1 >= source.length) return null;
      value += source[++index];
    } else if (source[index] === quote) {
      return { value, end: index + 1 };
    } else if (source[index] === "\n" && quote !== "`") {
      return null;
    } else {
      value += source[index];
    }
  }
  return null;
}

function trivia(source, start, css = false) {
  let index = start;
  for (;;) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return source.length;
      index = end + 2;
    } else if (!css && source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end < 0 ? source.length : end + 1;
    } else {
      return index;
    }
  }
}

function cssImport(source, start) {
  let index = trivia(source, start, true);
  if (source[index] === '"' || source[index] === "'") {
    const found = quoted(source, index);
    return found && { ...found, form: "quoted" };
  }
  if (source.slice(index, index + 3).toLowerCase() !== "url" || IDENTIFIER.test(source[index + 3] ?? "")) return null;
  index = trivia(source, index + 3, true);
  if (source[index] !== "(") return null;
  index = trivia(source, index + 1, true);
  if (source[index] === '"' || source[index] === "'") {
    const found = quoted(source, index);
    if (!found || source[trivia(source, found.end, true)] !== ")") return null;
    return { value: found.value, end: trivia(source, found.end, true) + 1, form: "url" };
  }
  const end = source.indexOf(")", index);
  return end < 0 ? null : { value: source.slice(index, end).trim(), end: end + 1, form: "url" };
}

function sassImportTrivia(source, start, indented, afterComma = false) {
  let index = start;
  for (;;) {
    while (/\s/.test(source[index] ?? "")) {
      if (indented && source[index] === "\n" && !afterComma) return index;
      index += 1;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      if (!afterComma) return newline < 0 ? source.length : newline;
      index = newline < 0 ? source.length : newline + 1;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return source.length;
      const newline = source.indexOf("\n", index + 2);
      if (indented && !afterComma && newline >= 0 && newline < end) return newline;
      index = end + 2;
    } else {
      return index;
    }
  }
}

/** Sass @import allows comma-separated URLs, and its indented form allows bare URLs. */
function sassImports(source, start, indented) {
  const values = [];
  let index = start;
  let afterComma = false;
  for (;;) {
    index = sassImportTrivia(source, index, indented, afterComma);
    if (index >= source.length || source[index] === ";" || source[index] === "\n") break;
    let item = cssImport(source, index);
    if (!item && indented) {
      const end = index + (source.slice(index).match(/^[^\s,;]+/)?.[0].length ?? 0);
      if (end > index) item = { value: source.slice(index, end), end, form: "bare" };
    }
    if (!item) break;
    index = sassImportTrivia(source, item.end, indented);
    const separator = source[index];
    const hasMedia = separator !== "," && separator !== ";" && separator !== "\n" && index < source.length;
    const cssFile = /\.css(?:[?#]|$)/i.test(item.value);
    // A media query or url() without a .css file is a runtime CSS import, not a Sass module.
    if ((!hasMedia && item.form !== "url") || cssFile) values.push(item.value);
    if (hasMedia) {
      const end = indented ? source.indexOf("\n", index) : source.indexOf(";", index);
      return { values, end: end < 0 ? source.length : end + 1 };
    }
    if (separator !== ",") break;
    index += 1;
    afterComma = true;
  }
  return { values, end: index + (source[index] === ";" ? 1 : 0) };
}

function regexEnd(source, start) {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === "[") inClass = true;
    else if (source[index] === "]") inClass = false;
    else if (source[index] === "/" && !inClass) {
      while (/[a-z]/i.test(source[index + 1] ?? "")) index += 1;
      return index + 1;
    } else if (source[index] === "\n") return null;
  }
  return null;
}

function templateImports(file, source, start) {
  const imports = [];
  for (let index = start + 1; index < source.length;) {
    if (source[index] === "\\") {
      index += 2;
    } else if (source[index] === "`") {
      return { imports, end: index + 1 };
    } else if (source[index] === "$" && source[index + 1] === "{") {
      const expressionStart = index + 2;
      let depth = 1;
      index = expressionStart;
      while (index < source.length && depth > 0) {
        if (source[index] === '"' || source[index] === "'" || source[index] === "`") {
          index = quoted(source, index)?.end ?? source.length;
        } else if (source.startsWith("//", index) || source.startsWith("/*", index)) {
          index = trivia(source, index);
        } else if (source[index] === "{") {
          depth += 1;
          index += 1;
        } else if (source[index] === "}") {
          depth -= 1;
          index += 1;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) return { imports, end: source.length };
      imports.push(...importSpecifiers(file, source.slice(expressionStart, index - 1)));
    } else {
      index += 1;
    }
  }
  return { imports, end: source.length };
}

/** Import specifiers in executable JS/TS or CSS, excluding comments and quoted source text. */
export function importSpecifiers(file, source) {
  if (!source) return [];
  const css = STYLESHEET.test(file);
  const sass = SASS_SOURCE.test(file);
  const found = [];
  let previous = "";
  for (let index = 0; index < source.length;) {
    const next = trivia(source, index, css && !sass);
    if (next !== index) {
      index = next;
      continue;
    }
    const char = source[index];
    if (!css && char === "`") {
      const template = templateImports(file, source, index);
      found.push(...template.imports);
      index = template.end;
      previous = "literal";
      continue;
    }
    if (char === '"' || char === "'") {
      const string = quoted(source, index);
      index = string?.end ?? source.length;
      previous = "literal";
      continue;
    }
    if (!css && char === "/" && (previous === "" || /^[=([{,:;!?&|+*%^<>~\/-]$/.test(previous)
      || /^(?:return|throw|case|delete|void|typeof|yield|await)$/.test(previous))) {
      const end = regexEnd(source, index);
      if (end !== null) {
        index = end;
        previous = "literal";
        continue;
      }
    }
    const sassRule = sass && (source.slice(index, index + 4).toLowerCase() === "@use" && !IDENTIFIER.test(source[index + 4] ?? "")
      ? 4 : source.slice(index, index + 8).toLowerCase() === "@forward" && !IDENTIFIER.test(source[index + 8] ?? "") ? 8 : 0);
    if (sassRule) {
      const valueAt = trivia(source, index + sassRule, false);
      const imported = source[valueAt] === '"' || source[valueAt] === "'" ? quoted(source, valueAt) : null;
      if (imported) {
        found.push(imported.value);
        index = imported.end;
        continue;
      }
    } else if (css && source.slice(index, index + 7).toLowerCase() === "@import" && !IDENTIFIER.test(source[index + 7] ?? "")) {
      if (sass) {
        const imported = sassImports(source, index + 7, /\.sass$/i.test(file));
        found.push(...imported.values);
        index = Math.max(index + 7, imported.end);
        continue;
      }
      const imported = cssImport(source, index + 7);
      if (imported) {
        found.push(imported.value);
        index = imported.end;
        continue;
      }
    } else if (!css && /[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (IDENTIFIER.test(source[end] ?? "")) end += 1;
      const word = source.slice(index, end);
      if (word === "import" || word === "from") {
        let valueAt = trivia(source, end);
        if (word === "import" && source[valueAt] === "(") valueAt = trivia(source, valueAt + 1);
        if (source[valueAt] === '"' || source[valueAt] === "'") {
          const imported = quoted(source, valueAt);
          if (imported) {
            found.push(imported.value);
            index = imported.end;
            previous = "literal";
            continue;
          }
        }
      }
      previous = word;
      index = end;
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return found;
}

/** Sass's local module lookup tries direct/partial files, then index files, and rejects ambiguity. */
function sassModule(stem, specifier, from, files) {
  const extension = /\.(?:sass|scss|css)$/i.exec(stem)?.[0] ?? "";
  if (extension === ".css") return files.has(stem) ? stem : undefined;
  const base = extension ? stem.slice(0, -extension.length) : stem;
  const basename = path.posix.basename(base);
  const partial = basename.startsWith("_") ? null : path.posix.join(path.posix.dirname(base), `_${basename}`);
  const extensions = extension ? [extension] : [".sass", ".scss", ".css"];
  const matches = [...new Set(extensions.flatMap((suffix) => [
    `${base}${suffix}`,
    ...(partial ? [`${partial}${suffix}`] : []),
  ]))].filter((candidate) => files.has(candidate));
  if (matches.length > 1) throw new Error(`ambiguous Sass module ${specifier} from ${from}: ${matches.join(", ")}`);
  if (matches.length) return matches[0];
  if (extension) return undefined;
  const indexes = ["index.sass", "index.scss", "_index.sass", "_index.scss"]
    .map((name) => path.posix.join(stem, name)).filter((candidate) => files.has(candidate));
  if (indexes.length > 1) throw new Error(`ambiguous Sass module ${specifier} from ${from}: ${indexes.join(", ")}`);
  return indexes[0];
}

/** An import specifier resolved to a file in `files` (relative, or a workspace alias the provider names), or undefined. */
export function resolveImport(from, specifier, files) {
  const target = STYLESHEET.test(from) ? specifier.split(/[?#]/, 1)[0] : specifier;
  let stems;
  if (target.startsWith(".")) {
    stems = [path.posix.join(path.posix.dirname(from), target)];
  } else if (workspaceAlias(target)) {
    const [, pkg, ...rest] = target.split("/");
    stems = workspaceAlias(target).bases.map((base) => base.replace("{package}", pkg).replace("{rest}", rest.join("/") || "index").replace(/\/index$/, ""));
  } else if (target.startsWith("@/")) {
    const suffix = target.slice(2);
    const appRoot = /^(apps\/[^/]+)\//.exec(from)?.[1];
    stems = [...(appRoot ? [`${appRoot}/src/${suffix}`, `${appRoot}/${suffix}`] : []), suffix];
  } else if (STYLESHEET.test(from) && !/^(?:\/|#|[a-z][\w+.-]*:)/i.test(target)) {
    // CSS @import URLs without `./` are still relative to the importing stylesheet.
    stems = [path.posix.join(path.posix.dirname(from), target)];
  } else {
    return undefined;
  }
  if (SASS_SOURCE.test(from)) {
    const resolved = stems.map((stem) => sassModule(stem, specifier, from, files)).filter(Boolean);
    if (resolved.length > 1) throw new Error(`ambiguous Sass module ${specifier} from ${from}: ${resolved.join(", ")}`);
    return resolved[0];
  }
  return stems.map((stem) => stem.replace(/\.js$/, "")).flatMap((stem) => SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`))
    .find((candidate) => files.has(candidate) && SOURCE_FILE.test(candidate));
}

/** Build a reusable import walker for one revision's file set and source reader. */
export function createImportClosure(files, readMany, include = () => true) {
  const imports = new Map();
  return (roots) => {
    const closure = new Set();
    let frontier = [...new Set(roots)].filter((file) => files.has(file));
    while (frontier.length) {
      const fresh = frontier.filter((file) => !closure.has(file) && include(file));
      if (closure.size + fresh.length > CLOSURE_LIMIT) throw new Error("source import closure exceeds 20000 files");
      const unread = fresh.filter((file) => IMPORT_SOURCE.test(file) && !imports.has(file));
      const texts = readMany(unread);
      for (const file of unread) {
        imports.set(file, importSpecifiers(file, texts.get(file))
          .map((specifier) => resolveImport(file, specifier, files)).filter(Boolean));
      }
      const next = new Set();
      for (const file of fresh) {
        closure.add(file);
        for (const target of imports.get(file) ?? []) if (!closure.has(target)) next.add(target);
      }
      frontier = [...next];
    }
    return closure;
  };
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The workspace import alias (the provider's `recipes.prEvidence.workspaceAliases`) a specifier starts with, or undefined. */
function workspaceAlias(specifier) {
  return (providerDataOr(sessionBinding(), "recipes", "prEvidence", null)?.workspaceAliases ?? []).find((alias) => specifier.startsWith(alias.prefix));
}
