import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import picomatch from "picomatch";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { isLocalPlanPath } from "../../../plugins/vibe/skills/vibe/scripts/local-plans.mjs";

const MODULE_PATH = /\.(?:[cm]?[jt]sx?|json)$/;
const CONFIG_PATH = /(?:^|\/)(?:tsconfig[^/]*\.json|(?:vitest|playwright|storybook|next|source)\.config\.[cm]?[jt]s|\.storybook\/main\.[cm]?[jt]s)$/;
const COLLECTOR_KEYS = new Set(["include", "files", "testDir", "testMatch", "stories"]);
const READERS = new Set(["readFile", "readFileSync", "createReadStream", "glob", "globSync", "fastGlob"]);
const UNKNOWN = "__VIBE_UNKNOWN_PATH__";
const UNKNOWN_HOST = UNKNOWN.toLowerCase();
const LEADING_PARENTS = /^(?:\.{1,2}\/)+/;
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const NO_FILE_TARGET = Symbol("no-file-target");
type PossibleUrl = { possibleUrl: URL; unknownPrefix?: boolean };
type PossiblePath = { possiblePath: string; unknownPrefix: boolean };
type PathValue = string | URL | PossibleUrl | PossiblePath | typeof NO_FILE_TARGET | undefined;

/** Receiver-specific references preserve complete targets; unknown pieces never become separate paths. */
export type InputReference = { kind: "path"; value: string; base: "module" | "runtime"; possibleOnly: boolean; unknownPrefix: boolean; uncertainTerms: string[] } | {
  kind: "collector" | "vite"; values: string[]; excludes: string[]; base: string; dot: boolean; unresolved: boolean;
};

/** One finite syntax owner serves both private evidence and retained-report admission. */
export function committedInputReferences(root: string, matches: (file: string, reference: InputReference) => boolean) {
  const files = git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean);
  return files.some((file) => {
    if (!MODULE_PATH.test(file) || isLocalPlanPath(file)) return false;
    const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    let found = false;
    const inspect = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        found ||= matchPath(node.moduleSpecifier, "module");
      } else if (ts.isCallExpression(node)) {
        if (isViteGlob(node.expression)) found ||= matches(file, viteReference(root, file, node));
        else {
          const name = callName(node.expression);
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === "require" || isReader(node.expression)) {
            const argument = node.arguments[0];
            if (argument) {
              if (["glob", "globSync", "fastGlob"].includes(name)) {
                found ||= matches(file, { kind: "collector", values: literalGroup(argument), excludes: [],
                  base: packageBase(root, file), dot: true, unresolved: false });
              } else found ||= matchPath(argument, node.expression.kind === ts.SyntaxKind.ImportKeyword || name === "require" ? "module" : "runtime");
            }
          }
        }
      } else if (CONFIG_PATH.test(file) && ts.isPropertyAssignment(node) && COLLECTOR_KEYS.has(propertyName(node.name))) {
        found ||= matches(file, { kind: "collector", values: literalGroup(node.initializer), excludes: collectorExcludes(node.parent),
          base: packageBase(root, file), dot: true, unresolved: false });
      }
      if (!found) ts.forEachChild(node, inspect);
    };
    const matchPath = (expression: ts.Expression, base: "module" | "runtime") => {
      const value = pathValue(expression, root, file, new Set());
      const target = fsTarget(value);
      if (!target) return false;
      return matches(file, { kind: "path", value: target.path, base, possibleOnly: target.possible, unknownPrefix: target.unknownPrefix,
        uncertainTerms: target.path.includes(UNKNOWN) ? expressionTerms(expression, root, file, new Set()) : [] });
    };
    inspect(source);
    return found;
  });
}

/** Matches complete expressions against finite canonical candidates without reading their bodies. */
export function referenceMatches(root: string, file: string, reference: InputReference, candidates: readonly string[]) {
  if (reference.kind === "path") {
    if (pathPossibility(root, file, reference.value, reference.base, candidates, reference.unknownPrefix)) return true;
    return reference.value === UNKNOWN && reference.uncertainTerms.some((term) => pathPossibility(root, file, term, reference.base, candidates));
  }
  const positives: string[] = [];
  const negatives = [...reference.excludes];
  for (const value of reference.values) {
    if (reference.kind === "vite" && value.startsWith("!")) negatives.push(value.slice(1));
    else positives.push(value);
  }
  if (reference.unresolved) return true;
  if (!positives.length) return false;
  const absolute = (pattern: string) => {
    if (reference.kind !== "vite") return pattern;
    if (pattern.startsWith("**")) return pattern;
    if (pattern.startsWith("/")) return join(packageBase(root, file), pattern.slice(1));
    return join(reference.base, pattern);
  };
  const match = picomatch(positives.map(absolute), { dot: reference.dot, ignore: negatives.map(absolute),
    ...(reference.kind === "vite" ? { noext: true } : {}) });
  return candidates.some((candidate) => match(reference.kind === "vite" ? join(root, candidate) : relative(reference.base, join(root, candidate))));
}

/** Explicit namespace references remain forbidden even when no candidate file exists yet. */
export function explicitPlanningReference(root: string, file: string, reference: InputReference) {
  if (reference.kind !== "path") return false;
  if (reference.value.includes(UNKNOWN)) {
    const suffix = reference.value.slice(reference.value.lastIndexOf(UNKNOWN) + UNKNOWN.length).replace(/^\/+/, "");
    return suffix === ".closedloop-ai/vibe-plans" || suffix.startsWith(".closedloop-ai/vibe-plans/")
      || reference.uncertainTerms.some((term) => term.includes(".closedloop-ai/vibe-plans"))
      || (reference.uncertainTerms.includes(".closedloop-ai") && reference.uncertainTerms.includes("vibe-plans"));
  }
  const target = reference.base === "runtime" && !isAbsolute(reference.value)
    ? normalize(reference.value).replace(LEADING_PARENTS, "")
    : relative(root, resolve(dirname(join(root, file)), reference.value));
  return isLocalPlanPath(target) || target === ".closedloop-ai/vibe-plans";
}

function callName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return importedName(expression) ?? expression.text;
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
}

function isViteGlob(expression: ts.Expression) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "glob"
    && ts.isMetaProperty(expression.expression) && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && expression.expression.name.text === "meta";
}

function isReader(expression: ts.Expression) {
  const name = callName(expression);
  if (!READERS.has(name)) return false;
  if (ts.isIdentifier(expression)) return true;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  // Legacy unqualified readers remain conservative, but never receive Vite's group semantics.
  return !isViteGlob(expression);
}

function viteReference(root: string, file: string, node: ts.CallExpression): InputReference {
  const values = node.arguments[0] ? literalGroup(node.arguments[0]) : [];
  let base = dirname(join(root, file));
  let dot = false;
  let unresolved = !node.arguments[0] || !literalGroupComplete(node.arguments[0])
    || values.some((value) => !["/", "./", "../", "**"].some((prefix) => value.replace(/^!/, "").startsWith(prefix)));
  const options = node.arguments[1];
  if (options && !ts.isObjectLiteralExpression(options)) unresolved = true;
  if (options && ts.isObjectLiteralExpression(options)) {
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property)) { unresolved = true; continue; }
      const name = propertyName(property.name);
      if (name === "exhaustive") {
        if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) dot = true;
        else if (property.initializer.kind !== ts.SyntaxKind.FalseKeyword) unresolved = true;
      } else if (name === "base") {
        if (!ts.isStringLiteralLike(property.initializer)) unresolved = true;
        else base = property.initializer.text.startsWith("/") ? join(packageBase(root, file), property.initializer.text)
          : resolve(base, property.initializer.text);
      } else if (!["eager", "import", "query", "as"].includes(name)) unresolved = true;
    }
  }
  return { kind: "vite", values, excludes: [], base, dot, unresolved };
}

function literalGroup(expression: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap((item) => literalGroup(item));
  return [];
}

function literalGroupComplete(expression: ts.Expression): boolean {
  return ts.isStringLiteralLike(expression)
    || (ts.isArrayLiteralExpression(expression) && expression.elements.every(literalGroupComplete));
}

function propertyName(name: ts.PropertyName) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "";
}

function collectorExcludes(node: ts.Node) {
  if (!ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === "exclude"
    ? literalGroup(property.initializer) : []);
}

function packageBase(root: string, file: string) {
  let base = dirname(join(root, file));
  while (base !== root && !existsSync(join(base, "package.json"))) base = dirname(base);
  return base;
}

function importedName(identifier: ts.Identifier) {
  const declaration = localDeclaration(identifier);
  if (declaration && ts.isImportSpecifier(declaration)) return (declaration.propertyName ?? declaration.name).text;
  return undefined;
}

function localDeclaration(identifier: ts.Identifier): ts.Node | undefined {
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find((item) => ts.isIdentifier(item.name) && item.name.text === identifier.text);
      if (parameter) return parameter;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    let found: ts.Node | undefined;
    const inspect = (node: ts.Node) => {
      if ((ts.isVariableDeclaration(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)
        || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === identifier.text) found = node;
      if (node !== scope && (ts.isBlock(node) || ts.isFunctionLike(node))) return;
      if (!found) ts.forEachChild(node, inspect);
    };
    inspect(scope);
    if (found) return found;
  }
  return undefined;
}

function builtin(expression: ts.Expression, names: readonly string[]) {
  if (ts.isIdentifier(expression)) {
    const declaration = localDeclaration(expression);
    if (!declaration || !ts.isImportSpecifier(declaration)) return false;
    const module = declaration.parent.parent.parent;
    return ts.isImportDeclaration(module) && ts.isStringLiteral(module.moduleSpecifier)
      && names.includes(module.moduleSpecifier.text);
  }
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression)) return false;
  const declaration = localDeclaration(expression.expression);
  if (!declaration) return false;
  let node: ts.Node | undefined = declaration;
  while (node && !ts.isImportDeclaration(node)) node = node.parent;
  return Boolean(node && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && names.includes(node.moduleSpecifier.text));
}

function pathValue(expression: ts.Expression, root: string, file: string, seen: Set<ts.Node>): PathValue {
  if (seen.size > 32 || seen.has(expression)) return UNKNOWN;
  seen = new Set(seen).add(expression);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return pathValue(expression.expression, root, file, seen);
  if (ts.isIdentifier(expression)) {
    const declaration = localDeclaration(expression);
    if (expression.text === "__dirname" && !declaration) return dirname(join(root, file));
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) {
      return pathValue(declaration.initializer, root, file, seen);
    }
    return UNKNOWN;
  }
  if (ts.isTemplateExpression(expression)) {
    const values = expression.templateSpans.map((part) => pathValue(part.expression, root, file, seen));
    if (values.includes(NO_FILE_TARGET)) return NO_FILE_TARGET;
    return expression.head.text + expression.templateSpans.map((part, index) => stringValue(values[index]) + part.literal.text).join("");
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "url" && ts.isMetaProperty(expression.expression)
    && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword) return pathToFileURL(join(root, file)).href;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = pathValue(expression.left, root, file, seen);
    const right = pathValue(expression.right, root, file, seen);
    if (left === NO_FILE_TARGET || right === NO_FILE_TARGET) return NO_FILE_TARGET;
    return stringValue(left) + stringValue(right);
  }
  if (ts.isNewExpression(expression) && isUrlConstructor(expression.expression)) {
    const argument = expression.arguments?.[0];
    const value = argument ? pathValue(argument, root, file, seen) : undefined;
    const baseArgument = expression.arguments?.[1];
    const base = baseArgument ? pathValue(baseArgument, root, file, seen) : undefined;
    if (!value) return UNKNOWN;
    return constructUrl(value, base);
  }
  if (!ts.isCallExpression(expression)) return UNKNOWN;
  const name = callName(expression.expression);
  if (ts.isPropertyAccessExpression(expression.expression) && name === "cwd"
    && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "process"
    && !localDeclaration(expression.expression.expression)) return `/${UNKNOWN}`;
  if (name === "fileURLToPath" && builtin(expression.expression, ["node:url", "url"])) {
    const argument = expression.arguments[0];
    const value = argument ? pathValue(argument, root, file, seen) : undefined;
    if (!value) return UNKNOWN;
    if (typeof value === "object" && !(value instanceof URL) && "possiblePath" in value) return NO_FILE_TARGET;
    const target = fsTarget(typeof value === "string" ? constructUrl(value, undefined) : value);
    if (!target) return NO_FILE_TARGET;
    return target.unknownPrefix ? { possiblePath: target.path, unknownPrefix: true } : target.path;
  }
  if (["join", "resolve"].includes(name) && builtin(expression.expression, ["node:path", "path"])) {
    const inputs = expression.arguments.map((argument) => pathValue(argument, root, file, seen));
    if (inputs.includes(NO_FILE_TARGET)) return NO_FILE_TARGET;
    const values = inputs.map((value) => {
      return typeof value === "string" || value && typeof value === "object" && "possiblePath" in value ? stringValue(value) : UNKNOWN;
    });
    if (name === "join") return join(...values);
    let absolute = -1;
    for (let index = 0; index < values.length; index++) if (isAbsolute(values[index]!)) absolute = index;
    if (absolute >= 0) return resolve(...values.slice(absolute));
    return `${UNKNOWN}/${join(...values)}`;
  }
  if (name === "tmpdir" && builtin(expression.expression, ["node:os", "os"])) return UNKNOWN;
  if (ts.isIdentifier(expression.expression)) {
    const declaration = localDeclaration(expression.expression);
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body && !declaration.parameters.length) {
      const returns = helperReturns(declaration.body);
      if (returns.length === 1 && returns[0]?.expression && declaration.body.statements.at(-1) === returns[0]) {
        return pathValue(returns[0].expression, root, file, seen);
      }
    }
  }
  return UNKNOWN;
}

/** Relevant terms in an unresolved target signal possibility, not an invented joined path or actual consumption. */
function expressionTerms(expression: ts.Expression, root: string, file: string, seen: Set<ts.Node>): string[] {
  if (seen.size > 32 || seen.has(expression)) return [];
  seen = new Set(seen).add(expression);
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) return [expression.head.text, ...expression.templateSpans.flatMap((span) =>
    [...expressionTerms(span.expression, root, file, seen), span.literal.text])];
  if (ts.isIdentifier(expression)) {
    const declaration = localDeclaration(expression);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const value = pathValue(declaration.initializer, root, file, new Set(seen));
      const target = fsTarget(value);
      const constraints = target && value && typeof value === "object"
        ? [target.unknownPrefix ? `${UNKNOWN}${target.path}` : target.path] : [];
      return [...constraints, ...expressionTerms(declaration.initializer, root, file, seen)];
    }
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const declaration = localDeclaration(expression.expression);
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body && !declaration.parameters.length) {
      return helperReturns(declaration.body).flatMap((statement) => {
        if (!statement.expression) return [];
        const value = pathValue(statement.expression, root, file, new Set(seen));
        const target = fsTarget(value);
        if (!target) return [];
        return [target.unknownPrefix ? `${UNKNOWN}${target.path}` : target.path, ...expressionTerms(statement.expression, root, file, seen)];
      });
    }
  }
  const terms: string[] = [];
  ts.forEachChild(expression, (node) => {
    if (ts.isExpression(node)) terms.push(...expressionTerms(node, root, file, seen));
  });
  return terms;
}

/** Relative Node targets have an unestablished runtime base; module specifiers retain importer semantics. */
function pathPossibility(root: string, file: string, value: string, base: "module" | "runtime", candidates: readonly string[], unknownPrefix = false) {
  const meaningful = value.split(UNKNOWN).join("").replace(LEADING_PARENTS, "").replaceAll("/", "");
  if (!meaningful || meaningful === "." || meaningful === "..") return false;
  if ((value.includes(UNKNOWN) || unknownPrefix) && !hasUncertainIdentity(root, value)) return false;
  let pattern = value;
  if (unknownPrefix) pattern = `${UNKNOWN}${pattern}`;
  else if (base === "runtime" && !isAbsolute(pattern)) {
    if (!pattern.startsWith(UNKNOWN)) pattern = `${UNKNOWN}/${normalize(pattern).replace(LEADING_PARENTS, "")}`;
  } else if (!isAbsolute(pattern)) pattern = resolve(dirname(join(root, file)), pattern);
  const match = new RegExp(`^${pattern.replace(REGEX_META, "\\$&").split(UNKNOWN).join(".*")}$`);
  return candidates.some((candidate) => match.test(join(root, candidate)));
}

function isUrlConstructor(expression: ts.Expression) {
  if (callName(expression) !== "URL") return false;
  if (builtin(expression, ["node:url", "url"])) return true;
  return ts.isIdentifier(expression) && expression.text === "URL" && !localDeclaration(expression);
}

/** Count actual returns without treating a nested function's return as its parent's outcome. */
function helperReturns(body: ts.Block) {
  const statements: ts.ReturnStatement[] = [];
  const inspect = (node: ts.Node) => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) statements.push(node);
    else ts.forEachChild(node, inspect);
  };
  inspect(body);
  return statements;
}

/** Only constructed builtin URL objects are decoded at the actual or possible fs-target boundary. */
function fsTarget(value: PathValue): { path: string; possible: boolean; unknownPrefix: boolean } | undefined {
  if (value === NO_FILE_TARGET) return undefined;
  if (typeof value === "string" || value === undefined) return { path: value ?? UNKNOWN, possible: Boolean(value?.includes(UNKNOWN)), unknownPrefix: false };
  if (!(value instanceof URL) && "possiblePath" in value) return { path: value.possiblePath, possible: true, unknownPrefix: value.unknownPrefix };
  const url = value instanceof URL ? value : value.possibleUrl;
  if (url.protocol !== "file:") return undefined;
  const projected = new URL(url.href);
  let possible = !(value instanceof URL) || url.href.includes(UNKNOWN);
  let unknownPrefix = !(value instanceof URL) && Boolean(value.unknownPrefix);
  if (projected.hostname && projected.hostname !== "localhost") {
    if (!projected.hostname.includes(UNKNOWN_HOST) || value instanceof URL) return undefined;
    projected.hostname = "";
    possible = true;
    unknownPrefix = true;
  }
  try { return { path: fileURLToPath(projected), possible, unknownPrefix }; } catch { return possible ? { path: UNKNOWN, possible: true, unknownPrefix } : undefined; }
}

/** Native parsing is shared; a symbolic projection carries possibility, never actual host/base evidence. */
function constructUrl(input: Exclude<PathValue, undefined>, base: PathValue): PathValue {
  if (input === NO_FILE_TARGET || base === NO_FILE_TARGET) return NO_FILE_TARGET;
  const path = typeof input === "object" && !(input instanceof URL) && "possiblePath" in input ? input : undefined;
  if (base && typeof base === "object" && !(base instanceof URL) && "possiblePath" in base) return NO_FILE_TARGET;
  const value = input instanceof URL || typeof input === "string" ? input : "possiblePath" in input ? input.possiblePath : input.possibleUrl;
  const baseValue = base instanceof URL || typeof base === "string" || base === undefined ? base : base.possibleUrl;
  const baseUncertain = base !== undefined && (typeof base !== "string" && !(base instanceof URL) || stringValue(base).includes(UNKNOWN));
  let url: URL;
  try { url = new URL(value, baseValue); } catch {
    if (!baseUncertain) return path ? NO_FILE_TARGET : UNKNOWN;
    try { url = new URL(value, `file:///${UNKNOWN}/`); } catch { return UNKNOWN; }
  }
  if (baseUncertain && typeof value === "string" && !URI_SCHEME.test(value) && !value.startsWith("/") && !url.href.includes(UNKNOWN)) {
    url.pathname = `/${UNKNOWN}${url.pathname}`;
  }
  const unknownPrefix = path?.unknownPrefix || typeof input === "object" && !(input instanceof URL) && "possibleUrl" in input && input.unknownPrefix;
  return baseUncertain || stringValue(input).includes(UNKNOWN) || url.href.includes(UNKNOWN)
    || typeof input !== "string" && !(input instanceof URL) ? { possibleUrl: url, ...(unknownPrefix ? { unknownPrefix: true } : {}) } : url;
}

function stringValue(value: PathValue) {
  if (value === NO_FILE_TARGET) return UNKNOWN;
  if (value && typeof value === "object" && !(value instanceof URL) && "possiblePath" in value) return value.unknownPrefix ? `${UNKNOWN}${value.possiblePath}` : value.possiblePath;
  if (value && typeof value === "object" && !(value instanceof URL)) return value.possibleUrl.href;
  return String(value ?? UNKNOWN);
}

/** A type suffix on an entirely unknown basename is not reference identity or a disjointness proof. */
function hasUncertainIdentity(root: string, value: string) {
  let residual = value;
  if (value === root) residual = "";
  else if (value.startsWith(`${root}/`)) residual = value.slice(root.length + 1);
  const parts = residual.split("/");
  return parts.some((part, index) => {
    const known = part.split(UNKNOWN).join("");
    if (!known || known === "." || known === "..") return false;
    if (index < parts.length - 1 || !part.includes(UNKNOWN)) return true;
    if (!part.startsWith(UNKNOWN)) return true;
    let suffix = part;
    while (suffix.startsWith(UNKNOWN)) suffix = suffix.slice(UNKNOWN.length);
    return !suffix.startsWith(".") || suffix.includes(UNKNOWN);
  });
}
