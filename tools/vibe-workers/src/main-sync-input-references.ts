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
const LEADING_SEPARATORS = /^\/+/;
const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const NO_FILE_TARGET = Symbol("no-file-target");
type PossibleUrl = { possibleUrl: URL; unknownPrefix?: boolean };
type PossiblePath = { possiblePath: string; unknownPrefix: boolean };
type IsolatedPath = { isolatedPath: string; identity: string };
type PathValue = string | URL | PossibleUrl | PossiblePath | IsolatedPath | typeof NO_FILE_TARGET | undefined;
type NativeLeafCollector = (node: ts.Node, index?: number) => void;
export type IsolatedTestArgument = { isolatedTest: true; identity: string; child: string };
export type SymbolicNativeArgument = { constraint: Extract<InputReference, { kind: "path" }> };
export type NativeReferenceEnvironment = { cwd?: string; argv: readonly (string | IsolatedTestArgument | SymbolicNativeArgument)[] };
const nativeEnvironments = new WeakMap<ts.SourceFile, NativeReferenceEnvironment>();

/** Public code/config paths supported by the shared parser; other imported files remain data. */
export function isInputModulePath(file: string) {
  return MODULE_PATH.test(file) && !isLocalPlanPath(file);
}

/** Receiver-specific references preserve complete targets; unknown pieces never become separate paths. */
export type InputReference = { kind: "path"; value: string; base: "module" | "runtime"; possibleOnly: boolean; unknownPrefix: boolean; uncertainTerms: string[]; isolatedTest?: true } | {
  kind: "collector" | "vite"; values: string[]; excludes: string[]; base: string; dot: boolean; unresolved: boolean;
};

/** One finite syntax owner serves both private evidence and retained-report admission. */
export function committedInputReferences(root: string, matches: (file: string, reference: InputReference) => boolean) {
  const files = git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean);
  return files.some((file) => isInputModulePath(file)
    && inputModuleReferences(root, file, matches, parseInputModule(root, file)));
}

/** The global private walk and selected report walk share the same syntax/binding owner. */
export function readInputModule(root: string, file: string, environment?: NativeReferenceEnvironment) {
  if (!isInputModulePath(file)) throw new Error("Input module is not a public committed source path");
  if (!git(root, ["ls-tree", "HEAD", "--", file])) throw new Error("Selected input module is not committed");
  return parseInputModule(root, file, environment);
}

/** Traverses a committed AST with caller-selected target semantics, without executing its body. */
export function inputModuleReferences(root: string, file: string, matches: (file: string, reference: InputReference) => boolean,
  source: ts.SourceFile) {
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
      const reference = inputExpressionReference(root, file, expression, base);
      return reference ? matches(file, reference) : false;
    };
    inspect(source);
    return found;
}

/** Matches complete expressions against finite canonical candidates without reading their bodies. */
export function referenceMatches(root: string, file: string, reference: InputReference, candidates: readonly string[]) {
  if (reference.kind === "path") {
    if (pathPossibility(root, file, reference.value, reference.base, candidates, reference.unknownPrefix)) return true;
    return (reference.value === UNKNOWN || reference.possibleOnly || reference.unknownPrefix)
      && reference.uncertainTerms.some((term) => pathPossibility(root, file, term, reference.base, candidates));
  }
  const positives: string[] = [];
  const negatives = [...reference.excludes];
  for (const value of reference.values) {
    if (reference.kind === "vite" && value.startsWith("!")) negatives.push(value.slice(1));
    else positives.push(value);
  }
  if (reference.unresolved) return true;
  if (!positives.length) return false;
  if (reference.kind === "collector") {
    const positiveMatchers = positives.map(pattern => collectorPattern(pattern, reference.dot));
    const ignoreMatchers = negatives.map(pattern => collectorPattern(pattern, reference.dot));
    return candidates.some(candidate => {
      const absoluteCandidate = join(root, candidate);
      const relativeCandidate = relative(reference.base, absoluteCandidate);
      const matches = (pattern: ReturnType<typeof collectorPattern>) => pattern.match(pattern.absolute ? absoluteCandidate : relativeCandidate);
      return positiveMatchers.some(matches) && !ignoreMatchers.some(matches);
    });
  }
  const absolute = (pattern: string) => {
    if (pattern.startsWith("**")) return pattern;
    if (pattern.startsWith("/")) return join(packageBase(root, file), pattern.slice(1));
    return join(reference.base, pattern);
  };
  const match = picomatch(positives.map(absolute), { dot: reference.dot, ignore: negatives.map(absolute),
    ...(reference.kind === "vite" ? { noext: true } : {}) });
  return candidates.some((candidate) => match(join(root, candidate)));
}

/** Explicit namespace references remain forbidden even when no candidate file exists yet. */
export function explicitPlanningReference(root: string, file: string, reference: InputReference) {
  if (reference.kind !== "path") return false;
  if (reference.value.includes(UNKNOWN) || reference.possibleOnly || reference.unknownPrefix) {
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

function pathValue(expression: ts.Expression, root: string, file: string, seen: Set<ts.Node>, collect?: NativeLeafCollector): PathValue {
  collect?.(expression);
  if (seen.size > 32 || seen.has(expression)) {
    if (collect) throw new RangeError("Native expression discovery is unproved");
    return UNKNOWN;
  }
  seen = new Set(seen).add(expression);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  const environment = nativeEnvironments.get(expression.getSourceFile());
  if (ts.isElementAccessExpression(expression) && ts.isNumericLiteral(expression.argumentExpression)
    && isProcessMember(expression.expression, "argv") && environment) {
    const argument = environment.argv[Number(expression.argumentExpression.text)];
    if (argument && typeof argument === "object") {
      if ("isolatedTest" in argument) return { isolatedPath: argument.child, identity: argument.identity };
      collect?.(expression, Number(expression.argumentExpression.text));
      const constraint = argument.constraint;
      return { possiblePath: constraint.value, unknownPrefix: constraint.unknownPrefix };
    }
    return argument;
  }
  if (ts.isConditionalExpression(expression) && environment) {
    const condition = pathValue(expression.condition, root, file, seen, collect);
    if (isIsolatedPath(condition)) return pathValue(expression.whenTrue, root, file, seen, collect);
    if (condition === undefined || typeof condition === "string" && !condition.includes(UNKNOWN)) {
      return pathValue(condition ? expression.whenTrue : expression.whenFalse, root, file, seen, collect);
    }
    return UNKNOWN;
  }
  if (ts.isParenthesizedExpression(expression)) return pathValue(expression.expression, root, file, seen, collect);
  if (ts.isIdentifier(expression)) {
    const declaration = localDeclaration(expression);
    if (expression.text === "__dirname" && !declaration) return dirname(join(root, file));
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) {
      return pathValue(declaration.initializer, root, file, seen, collect);
    }
    if (environment && declaration && ts.isImportSpecifier(declaration)) {
      const imported = importedConstant(root, expression.getSourceFile(), declaration, environment);
      if (imported) return pathValue(imported.expression, root, imported.file, seen, collect);
    }
    return UNKNOWN;
  }
  if (ts.isTemplateExpression(expression)) {
    const values = expression.templateSpans.map((part) => pathValue(part.expression, root, file, seen, collect));
    if (values.includes(NO_FILE_TARGET)) return NO_FILE_TARGET;
    return expression.head.text + expression.templateSpans.map((part, index) => stringValue(values[index]) + part.literal.text).join("");
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "url" && ts.isMetaProperty(expression.expression)
    && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword) return pathToFileURL(join(root, file)).href;
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "dirname" && ts.isMetaProperty(expression.expression)
    && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword) return dirname(join(root, file));
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = pathValue(expression.left, root, file, seen, collect);
    const right = pathValue(expression.right, root, file, seen, collect);
    if (left === NO_FILE_TARGET || right === NO_FILE_TARGET) return NO_FILE_TARGET;
    return stringValue(left) + stringValue(right);
  }
  if (ts.isNewExpression(expression) && isUrlConstructor(expression.expression)) {
    const argument = expression.arguments?.[0];
    const value = argument ? pathValue(argument, root, file, seen, collect) : undefined;
    const baseArgument = expression.arguments?.[1];
    const base = baseArgument ? pathValue(baseArgument, root, file, seen, collect) : undefined;
    if (!value) return UNKNOWN;
    return constructUrl(value, base);
  }
  if (!ts.isCallExpression(expression)) return UNKNOWN;
  const name = callName(expression.expression);
  if (name === "dirname" && builtin(expression.expression, ["node:path", "path"])) {
    const value = expression.arguments[0] && pathValue(expression.arguments[0], root, file, seen, collect);
    if (isIsolatedPath(value)) return { isolatedPath: dirname(value.isolatedPath), identity: value.identity };
    return typeof value === "string" && !value.includes(UNKNOWN) ? dirname(value) : UNKNOWN;
  }
  if (name === "cwd" && isProcessMember(expression.expression, "cwd")) {
    return environment?.cwd ?? { possiblePath: "/", unknownPrefix: true };
  }
  if (name === "fileURLToPath" && builtin(expression.expression, ["node:url", "url"])) {
    const argument = expression.arguments[0];
    const value = argument ? pathValue(argument, root, file, seen, collect) : undefined;
    if (!value) return UNKNOWN;
    if (typeof value === "object" && !(value instanceof URL) && "possiblePath" in value) return NO_FILE_TARGET;
    const target = fsTarget(typeof value === "string" ? constructUrl(value, undefined) : value);
    if (!target) return NO_FILE_TARGET;
    return target.unknownPrefix ? { possiblePath: target.path, unknownPrefix: true } : target.path;
  }
  if ((name === "join" || name === "resolve") && builtin(expression.expression, ["node:path", "path"])) {
    const inputs = expression.arguments.map((argument) => pathValue(argument, root, file, seen, collect));
    if (inputs.includes(NO_FILE_TARGET)) return NO_FILE_TARGET;
    const isolated = inputs.find(isIsolatedPath);
    if (isolated) {
      if (name === "resolve" && inputs.length === 1) return isolated;
      if (name === "join" && isIsolatedPath(inputs[0]) && inputs.slice(1).every(value => typeof value === "string" && !value.includes(UNKNOWN))) {
        const path = normalize(join(isolated.isolatedPath, ...inputs.slice(1) as string[]));
        if (!isAbsolute(path) && path !== ".." && !path.startsWith("../")) return { isolatedPath: path, identity: isolated.identity };
      }
      return UNKNOWN;
    }
    return nativePathOperation(name, inputs, environment?.cwd);
  }
  if (name === "tmpdir" && builtin(expression.expression, ["node:os", "os"])) return UNKNOWN;
  if (ts.isIdentifier(expression.expression)) {
    const declaration = localDeclaration(expression.expression);
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body && !declaration.parameters.length) {
      const returns = helperReturns(declaration.body);
      if (returns.length === 1 && returns[0]?.expression && declaration.body.statements.at(-1) === returns[0]) {
        return pathValue(returns[0].expression, root, file, seen, collect);
      }
    }
  }
  return UNKNOWN;
}

/** Relevant terms in an unresolved target signal possibility, not an invented joined path or actual consumption. */
function expressionTerms(expression: ts.Expression, root: string, file: string, seen: Set<ts.Node>, complete = false, collect?: NativeLeafCollector): string[] {
  collect?.(expression);
  if (seen.size > 32 || seen.has(expression)) {
    if (collect) throw new RangeError("Native term discovery is unproved");
    return [];
  }
  const value = complete ? pathValue(expression, root, file, seen, collect) : undefined;
  seen = new Set(seen).add(expression);
  if (complete) return completeExpressionTerms(expression, root, file, seen, value, collect);
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) return [expression.head.text, ...expression.templateSpans.flatMap((span) =>
    [...expressionTerms(span.expression, root, file, seen, false, collect), span.literal.text])];
  if (ts.isIdentifier(expression)) {
    const declaration = localDeclaration(expression);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const value = pathValue(declaration.initializer, root, file, new Set(seen), collect);
      const target = fsTarget(value);
      const constraints = target && value && typeof value === "object"
        ? [target.unknownPrefix ? `${UNKNOWN}${target.path}` : target.path] : [];
      return [...constraints, ...expressionTerms(declaration.initializer, root, file, seen, false, collect)];
    }
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const declaration = localDeclaration(expression.expression);
    if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body && !declaration.parameters.length) {
      return helperReturns(declaration.body).flatMap((statement) => {
        if (!statement.expression) return [];
        const value = pathValue(statement.expression, root, file, new Set(seen), collect);
        const target = fsTarget(value);
        if (!target) return [];
        return [target.unknownPrefix ? `${UNKNOWN}${target.path}` : target.path, ...expressionTerms(statement.expression, root, file, seen, false, collect)];
      });
    }
  }
  const terms: string[] = [];
  ts.forEachChild(expression, (node) => {
    if (ts.isExpression(node)) terms.push(...expressionTerms(node, root, file, seen, false, collect));
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
function fsTarget(value: PathValue): { path: string; possible: boolean; unknownPrefix: boolean; isolatedTest?: true } | undefined {
  if (value === NO_FILE_TARGET) return undefined;
  if (isIsolatedPath(value)) return { path: UNKNOWN, possible: true, unknownPrefix: false, isolatedTest: true };
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
  if (isIsolatedPath(input) || isIsolatedPath(base)) return UNKNOWN;
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
  if (value === NO_FILE_TARGET || isIsolatedPath(value)) return UNKNOWN;
  if (value && typeof value === "object" && !(value instanceof URL) && "possiblePath" in value) {
    if (!value.unknownPrefix) return value.possiblePath;
    return value.possiblePath === "/" ? UNKNOWN : `${UNKNOWN}${value.possiblePath}`;
  }
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

/** Native process operands are bound only for a selected invocation; shadowed objects remain unresolved. */
function isProcessMember(expression: ts.Expression, member: string) {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== member || !ts.isIdentifier(expression.expression)) return false;
  const identifier = expression.expression;
  const declaration = localDeclaration(identifier);
  if (!declaration) return identifier.text === "process";
  let node: ts.Node | undefined = declaration;
  while (node && !ts.isImportDeclaration(node)) node = node.parent;
  return Boolean(node && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
    && ["node:process", "process"].includes(node.moduleSpecifier.text));
}

function parseInputModule(root: string, file: string, environment?: NativeReferenceEnvironment) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
  if (environment) nativeEnvironments.set(source, environment);
  return source;
}

/** Selected invocation operands use exactly the same complete-expression semantics as both reference gates. */
export function inputExpressionReference(root: string, file: string, expression: ts.Expression,
  base: "module" | "runtime" = "runtime"): InputReference | undefined {
  const primary = evaluateInputReference(root, file, expression, base);
  const environment = nativeEnvironments.get(expression.getSourceFile());
  if (!primary || primary.isolatedTest || !environment || !primary.possibleOnly && !primary.unknownPrefix) return primary;
  const indexes = new Set<number>();
  const nodes = new Set<ts.Node>();
  evaluateInputReference(root, file, expression, base, (node, index) => {
    nodes.add(node);
    if (nodes.size > 256) throw new RangeError("Native expression discovery bound exceeded");
    if (index !== undefined) indexes.add(index);
  });
  const terms = new Set(primary.uncertainTerms);
  const source = expression.getSourceFile();
  try {
    for (const choice of nativeArgumentChoices(environment, indexes)) {
      nativeEnvironments.set(source, choice);
      const result = evaluateInputReference(root, file, expression, base);
      if (!result || result.isolatedTest) continue;
      terms.add(result.unknownPrefix ? `${UNKNOWN}${result.value}` : result.value);
      for (const term of result.uncertainTerms) terms.add(term);
      if (terms.size > 32) throw new RangeError("Native target alternative bound exceeded");
    }
  } finally { nativeEnvironments.set(source, environment); }
  return { ...primary, uncertainTerms: [...terms] };
}

/** Binding metadata is shared rather than rediscovered by the execution adapter. */
export function inputDeclaration(identifier: ts.Identifier) { return localDeclaration(identifier); }
export function inputBuiltin(expression: ts.Expression, modules: readonly string[]) { return builtin(expression, modules); }
export function inputCallName(expression: ts.Expression) { return callName(expression); }

/** Literal native operands never turn symbolic constraints into command arguments. */
export function inputKnownString(reference: InputReference | undefined) {
  return reference?.kind === "path" && !reference.possibleOnly && !reference.unknownPrefix
    && !reference.value.includes(UNKNOWN) && !reference.uncertainTerms.length ? reference.value : undefined;
}

function isIsolatedPath(value: PathValue): value is IsolatedPath {
  return Boolean(value && typeof value === "object" && "isolatedPath" in value);
}

/** Relative exported constants reuse native path parsing without evaluating imported modules. */
function importedConstant(root: string, source: ts.SourceFile, declaration: ts.ImportSpecifier, environment: NativeReferenceEnvironment) {
  const imported = declaration.parent.parent.parent;
  if (!ts.isImportDeclaration(imported) || !ts.isStringLiteral(imported.moduleSpecifier) || !imported.moduleSpecifier.text.startsWith(".")) return undefined;
  const base = resolve(dirname(join(root, source.fileName)), imported.moduleSpecifier.text);
  if (!base.startsWith(`${root}/`)) return undefined;
  const stem = relative(root, base);
  const files = [stem, stem.replace(/\.js$/, ".ts"), `${stem}.ts`, `${stem}.mjs`, `${stem}/index.ts`];
  const name = (declaration.propertyName ?? declaration.name).text;
  for (const file of files) {
    if (!existsSync(join(root, file)) || !MODULE_PATH.test(file) || isLocalPlanPath(file)) continue;
    const module = readInputModule(root, file, environment);
    for (const statement of module.statements) {
      if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      const item = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
      if (item?.initializer) return { expression: item.initializer, file };
    }
  }
  return undefined;
}

/** Absolute glob language stays intact; only literal pathnames use filesystem normalization. */
function collectorPattern(pattern: string, dot: boolean) {
  const scan = picomatch.scan(pattern);
  const prefix = scan.prefix && [...scan.prefix].every(character => character === "!") ? scan.prefix : "";
  const pathname = pattern.slice(prefix.length);
  const absolute = isAbsolute(pathname);
  const value = absolute && !scan.isGlob ? prefix + normalize(pathname) : pattern;
  return { absolute, match: picomatch(value, { dot }) };
}

/** Symbolic depth cannot certify an earlier anchor after native parent normalization. */
function nativePathOperation(operation: "join" | "resolve", inputs: readonly PathValue[], cwd: string | undefined): PathValue {
  const known = (value: PathValue): value is string => typeof value === "string" && !value.includes(UNKNOWN);
  if (operation === "join" && inputs.every(known)) return join(...inputs);
  let result: string | PossiblePath = "";
  if (operation === "resolve") result = cwd ?? { possiblePath: "/", unknownPrefix: true };
  for (const input of inputs) {
    if (!known(input)) {
      let value = UNKNOWN;
      if (input && typeof input === "object" && "possiblePath" in input) value = input.possiblePath;
      else if (typeof input === "string") value = input;
      const suffix = value.includes(UNKNOWN) ? value.slice(value.lastIndexOf(UNKNOWN) + UNKNOWN.length) : value;
      result = { possiblePath: join("/", suffix), unknownPrefix: true };
    } else if (operation === "resolve" && isAbsolute(input)) result = normalize(input);
    else if (typeof result === "string") result = join(result, input);
    else result = { possiblePath: join("/", result.possiblePath, input), unknownPrefix: true };
  }
  if (operation === "resolve" && typeof result === "string" && isAbsolute(result)) return resolve(result);
  return result;
}

/** Keep complete native constraints separately from the depth-independent primary residual. */
function completeExpressionTerms(expression: ts.Expression, root: string, file: string, seen: Set<ts.Node>, value: PathValue, collect?: NativeLeafCollector): string[] {
  const target = fsTarget(value);
  if (!target || target.isolatedTest) return [];
  if (ts.isParenthesizedExpression(expression)) return expressionTerms(expression.expression, root, file, seen, true, collect);
  if (ts.isIdentifier(expression)) {
    const declaration = localDeclaration(expression);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return expressionTerms(declaration.initializer, root, file, seen, true, collect);
    }
  }
  if (ts.isCallExpression(expression)) {
    const name = callName(expression.expression);
    if ((name === "join" || name === "resolve") && builtin(expression.expression, ["node:path", "path"])) {
      const inputs = expression.arguments.map(argument => pathValue(argument, root, file, seen, collect));
      return [nativePathConstraint(name, inputs, nativeEnvironments.get(expression.getSourceFile())?.cwd)];
    }
    if (name === "fileURLToPath" && builtin(expression.expression, ["node:url", "url"]) && expression.arguments[0]) {
      const argument = expression.arguments[0];
      const input = pathValue(argument, root, file, seen, collect);
      const terms = expressionTerms(argument, root, file, seen, true, collect);
      if (input && typeof input === "object") return terms;
      return urlConstraintTerms(terms, undefined);
    }
    if (ts.isIdentifier(expression.expression)) {
      const declaration = localDeclaration(expression.expression);
      if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body && !declaration.parameters.length) {
        return helperReturns(declaration.body).flatMap(statement => statement.expression
          ? expressionTerms(statement.expression, root, file, seen, true, collect) : []);
      }
    }
  }
  if (ts.isNewExpression(expression) && isUrlConstructor(expression.expression) && expression.arguments?.[0]) {
    const base = expression.arguments[1] && pathValue(expression.arguments[1], root, file, seen, collect);
    return urlConstraintTerms(expressionTerms(expression.arguments[0], root, file, seen, true, collect), base);
  }
  return [target.unknownPrefix ? `${UNKNOWN}${target.path}` : target.path];
}

/** Known runs normalize natively; unknown spans never supply a parent depth or exact anchor. */
function nativePathConstraint(operation: "join" | "resolve", inputs: readonly PathValue[], cwd: string | undefined): string {
  let values = [...inputs];
  if (operation === "resolve") {
    values.unshift(cwd ?? UNKNOWN);
    let reset = 0;
    values.forEach((value, index) => {
      if (typeof value === "string" && !value.includes(UNKNOWN) && isAbsolute(value)) reset = index;
    });
    values = values.slice(reset);
  }
  const parts: string[] = [];
  let known: string[] = [];
  const flush = () => {
    if (known.length) { parts.push(join(...known)); known = []; }
  };
  for (const value of values) {
    if (typeof value === "string" && !value.includes(UNKNOWN)) known.push(value);
    else { flush(); parts.push(stringValue(value)); }
  }
  flush();
  return parts.map((part, index) => {
    let value = index ? part.replace(LEADING_SEPARATORS, "") : part;
    if (index < parts.length - 1 && value.endsWith("/")) value = value.slice(0, -1);
    return value;
  }).join("/");
}

/** Only proven native URL operations project complete constraints to filesystem targets. */
function urlConstraintTerms(terms: readonly string[], base: PathValue): string[] {
  return terms.flatMap(term => {
    const target = fsTarget(constructUrl(term, base));
    return target ? [target.unknownPrefix ? `${UNKNOWN}${target.path}` : target.path] : [];
  });
}

/** Each alternative is evaluated at its native leaf before the complete target reaches a matcher. */
function evaluateInputReference(root: string, file: string, expression: ts.Expression, base: "module" | "runtime", collect?: NativeLeafCollector) {
  const value = pathValue(expression, root, file, new Set(), collect);
  const target = fsTarget(value);
  if (!target) return undefined;
  return { kind: "path" as const, value: target.path, base, possibleOnly: target.possible, unknownPrefix: target.unknownPrefix,
    ...(target.isolatedTest ? { isolatedTest: true as const } : {}),
    uncertainTerms: (target.possible || target.unknownPrefix || target.path.includes(UNKNOWN)) && !target.isolatedTest
      ? expressionTerms(expression, root, file, new Set(), target.path !== UNKNOWN, collect) : [] };
}

/** A repeated index shares one choice; distinct indices form a finite correlated environment set. */
function nativeArgumentChoices(environment: NativeReferenceEnvironment, indexes: ReadonlySet<number>): NativeReferenceEnvironment[] {
  let choices = [environment];
  for (const index of indexes) {
    const argument = environment.argv[index];
    if (!argument || typeof argument !== "object" || !("constraint" in argument)) continue;
    const constraint = argument.constraint;
    const values = [...new Set([constraint.value, ...constraint.uncertainTerms])];
    const next: NativeReferenceEnvironment[] = [];
    for (const choice of choices) {
      for (const value of values) {
        const argv = [...choice.argv];
        let projected = value;
        if (constraint.unknownPrefix && !isAbsolute(value) && !URI_SCHEME.test(value)) {
          projected = `/${value.startsWith(UNKNOWN) ? value : `${UNKNOWN}/${value}`}`;
        }
        argv[index] = { constraint: { ...constraint, value: projected, possibleOnly: true, uncertainTerms: [] } };
        next.push({ ...environment, argv });
        if (next.length > 32) throw new RangeError("Native argument alternative bound exceeded");
      }
    }
    choices = next;
  }
  return choices;
}
