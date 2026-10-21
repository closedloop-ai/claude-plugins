// A text-only reading of one JavaScript or TypeScript module's top level: its
// statements, the names each declares and references, its imports and its
// exports. The route rule uses it to follow an endpoint from the helper export
// that names it to the specs that import that export. A file it cannot split
// reports `ok: false` with the reason, and the caller falls back to file level.

import { IMPORT_SPECIFIER } from "./source-imports.mjs";

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = { ")": "(", "]": "[", "}": "{" };
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|else|do|yield|await)$/;
const CONTINUATION = /^[.?:+\-*/&|,=>)\]}]/;
const IDENTIFIER = /(?<![\w$])(?<!(?<!\.\.)\.)[A-Za-z_$][\w$]*/g;
const IMPORT_TYPE = /^import\s+type\s/;
const IMPORT_FROM = /^import\s+([\s\S]+?)\s+from\s*["']([^"']+)["']/;
const IMPORT_BARE = /^import\s*["']([^"']+)["']/;
const EXPORT_STAR = /^export\s+(type\s+)?\*\s+(?:as\s+([\w$]+)\s+)?from\s*["']([^"']+)["']/;
const EXPORT_LIST = /^export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/;
const EXPORT_DEFAULT = /^export\s+default\s+(?:(?:async\s+)?function\s*\*?\s*([\w$]+)|(?:abstract\s+)?class\s+([\w$]+))?/;
const DECLARATION = /^(export\s+)?(?:declare\s+)?(?:(?:async\s+)?function\s*\*?\s*([\w$]+)|(?:abstract\s+)?class\s+([\w$]+)|(?:const\s+)?enum\s+([\w$]+)|(?:type|interface)\s+([\w$]+)|(?:const|let|var)\s+([\s\S]*))/;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const NAMESPACE_CLAUSE = /\*\s*as\s+([\w$]+)/;
const DEFAULT_CLAUSE = /^([\w$]+)\s*(?:,|$)/;
const PATTERN_KEY = /[\w$]+\s*:/g;

/**
 * Splits `text` into top-level statements. A statement starts at a line whose
 * first column is code at bracket depth zero (formatted source puts every
 * top-level statement there); `code` drops comments, `idents` also drops string
 * and template text so a reference is never read out of a literal.
 */
export function splitTopLevel(text) {
  const code = [...text];
  const idents = [...text];
  const stack = [];
  const starts = [0];
  let state = "code";
  let quote = "";
  let inClass = false;
  let last = "";
  let word = "";
  const blank = (index, keepCode) => {
    if (text[index] !== "\n") {
      idents[index] = " ";
      if (!keepCode) {
        code[index] = " ";
      }
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\n" && state !== "string") {
      if (state === "line") {
        state = "code";
      }
      if (state === "code" && stack.length === 0) {
        starts.push(index + 1);
      }
      continue;
    }
    switch (state) {
      case "line":
      case "block":
        blank(index, false);
        if (state === "block" && char === "*" && next === "/") {
          blank(index + 1, false);
          index += 1;
          state = "code";
        }
        continue;
      case "string":
        blank(index, true);
        if (char === "\\") {
          blank(index + 1, true);
          index += 1;
        } else if (char === quote || char === "\n") {
          state = "code";
          last = quote;
        }
        continue;
      case "template":
        blank(index, true);
        if (char === "\\") {
          blank(index + 1, true);
          index += 1;
        } else if (char === "`") {
          state = "code";
          last = "`";
        } else if (char === "$" && next === "{") {
          blank(index + 1, true);
          index += 1;
          stack.push("${");
          state = "code";
          last = "{";
        }
        continue;
      case "regex":
        blank(index, true);
        if (char === "\\") {
          blank(index + 1, true);
          index += 1;
        } else if (char === "[") {
          inClass = true;
        } else if (char === "]") {
          inClass = false;
        } else if (char === "/" && !inClass) {
          state = "code";
          last = "/";
          word = "";
        }
        continue;
      default:
        break;
    }
    if (char === "/" && next === "/") {
      state = "line";
      blank(index, false);
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block";
      blank(index, false);
      continue;
    }
    if (char === "\"" || char === "'") {
      state = "string";
      quote = char;
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }
    if (char === "/" && (last === "" || REGEX_AFTER.has(last) || REGEX_AFTER_WORD.test(word))) {
      state = "regex";
      inClass = false;
      blank(index, true);
      continue;
    }
    if (OPENERS.has(char)) {
      stack.push(char);
    } else if (char in CLOSERS) {
      const open = stack.pop();
      if (open === "${" && char === "}") {
        state = "template";
        blank(index, true);
        continue;
      }
      if (open !== CLOSERS[char]) {
        return { ok: false, reason: `unbalanced ${char} at offset ${index}`, statements: [] };
      }
    }
    if (!/\s/.test(char)) {
      last = char;
      word = /[\w$]/.test(char) ? `${word}${char}`.slice(-12) : "";
    }
  }
  if (state !== "code" && state !== "line") {
    return { ok: false, reason: `unterminated ${state}`, statements: [] };
  }
  if (stack.length) {
    return { ok: false, reason: `unclosed ${stack.at(-1)}`, statements: [] };
  }
  return { ok: true, reason: null, statements: statementsFrom(code.join(""), idents.join(""), starts) };
}

function statementsFrom(code, idents, lineStarts) {
  const starts = lineStarts.filter((at) => /\S/.test(code[at] ?? "") && !CONTINUATION.test(code[at]));
  return starts.map((at, index) => {
    const end = starts[index + 1] ?? code.length;
    return { code: code.slice(at, end).trim(), idents: idents.slice(at, end) };
  });
}

/**
 * The module's top-level shape. `resolve(specifier)` returns the imported file
 * or undefined (a module outside the files being followed). Type-only imports
 * and exports are dropped: they cannot reach anything at run time.
 */
export function moduleShape(text, resolve) {
  const split = splitTopLevel(text);
  const shape = {
    ok: split.ok,
    reason: split.reason,
    text,
    unsplitImports: split.ok ? [] : [...text.matchAll(IMPORT_SPECIFIER)].map((found) => resolve(found[1])).filter(Boolean),
    statements: [],
    imports: new Map(),
    namespaces: new Map(),
    fileImports: [],
    exports: new Map(),
    stars: [],
  };
  for (const statement of split.statements) {
    readStatement(statement, resolve, shape);
  }
  return shape;
}

function readStatement({ code, idents }, resolve, shape) {
  const dynamic = [...code.matchAll(DYNAMIC_IMPORT)].map((found) => resolve(found[1])).filter(Boolean);
  shape.fileImports.push(...dynamic.map((target) => ({ target, how: "dynamic import" })));
  if (IMPORT_TYPE.test(code)) {
    return;
  }
  let match = IMPORT_FROM.exec(code);
  if (match) {
    readImportClause(match[1], resolve(match[2]), shape);
    return;
  }
  match = IMPORT_BARE.exec(code);
  if (match) {
    const target = resolve(match[1]);
    if (target) {
      shape.fileImports.push({ target, how: "side-effect import" });
    }
    return;
  }
  match = EXPORT_STAR.exec(code);
  if (match) {
    const target = resolve(match[3]);
    if (!match[1] && target) {
      if (match[2]) {
        shape.exports.set(match[2], { namespace: target });
      } else {
        shape.stars.push(target);
      }
    }
    return;
  }
  match = EXPORT_LIST.exec(code);
  if (match) {
    if (!match[1]) {
      const target = match[3] === undefined ? null : resolve(match[3]);
      for (const { from, to } of specifiers(match[2])) {
        if (match[3] === undefined) {
          shape.exports.set(to, { local: from });
        } else if (target) {
          shape.exports.set(to, { target, name: from });
        }
      }
    }
    return;
  }
  const names = [];
  match = EXPORT_DEFAULT.exec(code);
  if (match) {
    const local = match[1] ?? match[2] ?? "default";
    names.push(local);
    shape.exports.set("default", { local });
  } else {
    match = DECLARATION.exec(code);
    if (match) {
      const declared = match[6] === undefined ? [match[2] ?? match[3] ?? match[4] ?? match[5]] : bindingNames(match[6]);
      names.push(...declared);
      if (match[1]) {
        declared.forEach((name) => shape.exports.set(name, { local: name }));
      }
    }
  }
  shape.statements.push({ code, names, refs: new Set(idents.match(IDENTIFIER) ?? []), dynamic });
}

function readImportClause(clause, target, shape) {
  if (!target) {
    return;
  }
  const namespace = NAMESPACE_CLAUSE.exec(clause);
  if (namespace) {
    shape.namespaces.set(namespace[1], target);
  }
  const fallback = DEFAULT_CLAUSE.exec(clause.trim());
  if (fallback && fallback[1] !== "type") {
    shape.imports.set(fallback[1], { target, name: "default" });
  }
  const list = /\{([^}]*)\}/.exec(clause);
  for (const { from, to } of list ? specifiers(list[1]) : []) {
    shape.imports.set(to, { target, name: from });
  }
}

/** `a`, `a as b` and `type a` entries of an import or export list; type-only entries dropped. */
function specifiers(list) {
  return list.split(",").map((entry) => entry.trim()).filter((entry) => entry && !/^type\s/.test(entry)).map((entry) => {
    const [from, to] = entry.split(/\s+as\s+/);
    return { from: from.trim(), to: (to ?? from).trim() };
  });
}

/** Names bound by a `const`/`let`/`var` declarator: one identifier, or every binding in a destructuring pattern. */
function bindingNames(rest) {
  const trimmed = rest.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return [/^[\w$]+/.exec(trimmed)?.[0]].filter(Boolean);
  }
  const close = trimmed.indexOf("=");
  const pattern = (close < 0 ? trimmed : trimmed.slice(0, close)).replace(PATTERN_KEY, " ");
  return pattern.match(/[A-Za-z_$][\w$]*/g) ?? [];
}
