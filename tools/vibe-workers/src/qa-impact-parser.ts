export { registeredStoryNames, storyCollectionGlobs } from "./story-registration.js";
export { storyFlagBindings, exportedStoryRenderer } from "./story-render.js";
export { storyFlagArms } from "./story-flag-arms.js";
import { posix } from "node:path";
import * as ts from "typescript";

export const BUNDLED_TYPESCRIPT_VERSION = ts.version;

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

function scriptKind(file: string): ts.ScriptKind | null {
  const extension = Object.keys(SCRIPT_KINDS).find((candidate) => file.toLowerCase().endsWith(candidate));
  return extension ? SCRIPT_KINDS[extension] ?? null : null;
}

/**
 * Parses one JavaScript or TypeScript file with the compiler bundled into the
 * vibe plugin and prints its AST without comments. A null result is a proof
 * failure, never evidence that an edit is comment-only.
 */
export function commentlessAst(file: string, source: string): string | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(tree);
}

function inventoryArray(node: ts.ArrayLiteralExpression): boolean {
  const words = node.elements.map((item) => ts.isStringLiteralLike(item) ? item.text : null);
  const command = words.findIndex((text) => text === "ls-tree" || text === "ls-files");
  if (command < 0) return false;
  const separator = words.indexOf("--", command + 1);
  const flags = words.slice(command + 1, separator === -1 ? undefined : separator);
  if (words[command] === "ls-tree") return flags.some((flag) => flag === "--recursive" || /^-[a-z]*r[a-z]*$/i.test(flag ?? ""));
  if (separator === -1) return true;
  return node.elements.slice(separator + 1).some((item) => {
    if (ts.isSpreadElement(item)) return true;
    const pathspec = ts.isTemplateExpression(item) ? item.head.text : ts.isStringLiteralLike(item) ? item.text : "";
    return /^(?:\.?\/?$|:(?:\(glob\))?\*\*|\*\*)/.test(pathspec) && pathspec !== "";
  });
}

function inventoryOwnerNames(tree: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
      || !node.moduleSpecifier.text.startsWith(".")
      || posix.normalize(posix.join(posix.dirname(tree.fileName), node.moduleSpecifier.text))
        !== "plugins/vibe/lib/vibe/scripts/git-inventory.mjs") continue;
    const imports = node.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    for (const specifier of imports.elements) {
      if (!specifier.isTypeOnly && (specifier.propertyName ?? specifier.name).text === "readGitInventory") bindings.add(specifier.name.text);
    }
  }
  return bindings;
}

/** Locate recursive tree or whole-index argv that reaches a runner outside the shared inventory owner. */
export function rawGitInventoryLines(file: string, source: string): number[] | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  const owners = inventoryOwnerNames(tree);
  const arrays: ts.ArrayLiteralExpression[] = [];
  const references = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isArrayLiteralExpression(node) && inventoryArray(node)) arrays.push(node);
    if (ts.isIdentifier(node)) {
      const refs = references.get(node.text) ?? [];
      refs.push(node);
      references.set(node.text, refs);
      if ((ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isFunctionDeclaration(node.parent))
        && node.parent.name === node) owners.delete(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const accepted = (node: ts.Node): boolean => {
    const parent = node.parent;
    return ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && owners.has(parent.expression.text)
      && parent.arguments[1] === node;
  };
  const acceptedVariable = (array: ts.ArrayLiteralExpression): boolean => {
    const declaration = array.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || declaration.initializer !== array) return false;
    let block: ts.Node = declaration;
    while (block.parent && !ts.isBlock(block) && !ts.isSourceFile(block)) block = block.parent;
    const uses = references.get(declaration.name.text)?.filter((node) => node !== declaration.name
      && node.pos >= block.pos && node.end <= block.end) ?? [];
    return uses.length > 0 && uses.every(accepted);
  };
  return [...new Set(arrays.filter((array) => !accepted(array) && !acceptedVariable(array))
    .map((array) => tree.getLineAndCharacterOfPosition(array.getStart(tree)).line + 1))];
}

/** Prove a nested compare-shaped closure can only serve as an awaited call, never a callback value. */
export function awaitedLocalCompareLines(file: string, source: string): number[] | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;

  const references = new Map<string, ts.Identifier[]>();
  const declarations: Array<{ declaration: ts.VariableDeclaration; name: ts.Identifier; owner: ts.SignatureDeclaration }> = [];
  const visit = (node: ts.Node, owner: ts.SignatureDeclaration | null): void => {
    if (ts.isIdentifier(node) && /^compare[\w$]*$/.test(node.text)) {
      const sameName = references.get(node.text) ?? [];
      sameName.push(node);
      references.set(node.text, sameName);
      const declaration = node.parent;
      if (owner && ts.isVariableDeclaration(declaration) && declaration.name === node && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        declarations.push({ declaration, name: node, owner });
      }
    }
    const scope = ts.isFunctionLike(node) ? node : owner;
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(tree, null);
  return declarations.flatMap(({ declaration, name, owner }) => {
    // Closures nested within the owner can still use the binding. Separate functions cannot.
    const uses = references.get(name.text)?.filter((reference) =>
      reference !== name && reference.pos >= owner.pos && reference.end <= owner.end) ?? [];
    if (uses.length === 0 || !uses.every((reference) => {
      // Node identity distinguishes the call's callee from an identifier in its arguments.
      const parent = reference.parent;
      return ts.isCallExpression(parent) && parent.expression === reference
        && ts.isAwaitExpression(parent.parent) && parent.parent.expression === parent;
    })) return [];
    return [tree.getLineAndCharacterOfPosition(declaration.getStart(tree)).line + 1];
  });
}

const TEST_RUNNERS = new Set(["node:test", "vitest", "@playwright/test"]);
type SourceSpan = { start: number; end: number };

function assertionSpans(tree: ts.SourceFile, body: ts.Node): SourceSpan[] {
  const bindings = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !["node:assert", "node:assert/strict", "assert", "assert/strict"].includes(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name && !clause.isTypeOnly) bindings.add(clause.name.text);
  }
  const spans: SourceSpan[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const owner = ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : call.expression;
      if (ts.isIdentifier(owner) && bindings.has(owner.text)) spans.push({ start: call.getStart(tree), end: call.end });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return spans;
}

/**
 * Finds direct top-level cases under real test runner imports. Exact source spans
 * let the repair gate verify a moved declaration without normalizing assertions.
 */
export function topLevelTestCases(
  file: string,
  source: string,
  includeAssertions = false,
): Array<SourceSpan & { name: string; runner: string; assertions?: SourceSpan[] }> | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  const bindings = new Map<string, string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const runner = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !TEST_RUNNERS.has(runner)) continue;
    if (runner === "node:test" && clause.name) bindings.set(clause.name.text, `${runner}:test`);
    if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const specifier of clause.namedBindings.elements) {
      const name = (specifier.propertyName ?? specifier.name).text;
      if (!specifier.isTypeOnly && ["test", "it"].includes(name)) bindings.set(specifier.name.text, `${runner}:${name}`);
    }
  }
  return tree.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || call.questionDotToken) return [];
    const runner = bindings.get(call.expression.text);
    const [title, callback] = call.arguments;
    if (!runner || !title || !ts.isStringLiteral(title) || call.arguments.length !== 2
      || !callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return [];
    return [{ name: title.text, runner, start: statement.getStart(tree), end: statement.end,
      ...(includeAssertions ? { assertions: assertionSpans(tree, callback.body) } : {}) }];
  });
}

/** Real comment trivia, excluding comment-like text in JSX, strings and templates. */
export function sourceComments(file: string, source: string): string[] | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const variant = kind === ts.ScriptKind.TSX || kind === ts.ScriptKind.JSX ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, variant, source);
  const comments: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push(scanner.getTokenText());
    }
  }
  return comments;
}

/**
 * Returns whether a named module-level export is an exact constant-null function or arrow.
 * A parse failure returns null so callers fail closed instead of trusting lexical scope guesses.
 */
export function moduleExportReturnsOnlyNull(file: string, source: string, name: string): boolean | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  const exported = (node: ts.Node) => ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
  let dynamicWrite = false;
  const findEval = (node: ts.Node): void => {
    if (dynamicWrite) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") dynamicWrite = true;
    else ts.forEachChild(node, findEval);
  };
  findEval(tree);
  if (dynamicWrite) return false;
  const targetNames = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === name;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return false;
    if (ts.isShorthandPropertyAssignment(node)) return node.name.text === name;
    let found = false;
    ts.forEachChild(node, (child) => { if (!found && targetNames(child)) found = true; });
    return found;
  };
  const reassigned = () => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isBinaryExpression(node) && targetNames(node.left)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) found = true;
      else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && targetNames(node.initializer)) found = true;
      else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && targetNames(node.operand)) found = true;
      else ts.forEachChild(node, visit);
    };
    visit(tree);
    return found;
  };
  const matches: boolean[] = [];
  for (const statement of tree.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.some((element) => element.name.text === name)) {
      matches.push(false);
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && exported(statement) && statement.name?.text === name) {
      const body = statement.body?.statements;
      const only = body?.[0];
      matches.push(!reassigned() && body?.length === 1 && only !== undefined && ts.isReturnStatement(only)
        && only.expression?.kind === ts.SyntaxKind.NullKeyword);
      continue;
    }
    if (!ts.isVariableStatement(statement) || !exported(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      matches.push(!reassigned() && ts.isArrowFunction(declaration.initializer)
        && declaration.initializer.body.kind === ts.SyntaxKind.NullKeyword);
    }
  }
  return matches.length === 1 && matches[0] === true;
}

/** Resolve one real module-level named import, excluding comment and string lookalikes. */
export function moduleNamedImport(
  file: string,
  source: string,
  localName: string,
): { imported: string; specifier: string } | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  let shadowed = false;
  const bindingNames = (node: ts.BindingName): boolean => ts.isIdentifier(node)
    ? node.text === localName : node.elements.some((element) => !ts.isOmittedExpression(element)
      && bindingNames(element.name));
  const findShadow = (node: ts.Node): void => {
    if (shadowed) return;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
      || ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name?.text === localName) shadowed = true;
    else if ((ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name.text === localName) shadowed = true;
    else if (ts.isImportEqualsDeclaration(node) && node.name.text === localName) shadowed = true;
    else if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && bindingNames(node.name)) shadowed = true;
    else ts.forEachChild(node, findShadow);
  };
  findShadow(tree);
  if (shadowed) return null;
  const imports: Array<{ imported: string; specifier: string }> = [];
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.importClause?.name?.text === localName) return null;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === localName) return null;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text === localName) {
        imports.push({ imported: element.propertyName?.text ?? element.name.text, specifier: statement.moduleSpecifier.text });
      }
    }
  }
  return imports.length === 1 ? imports[0]! : null;
}

/** Compare two snippets while permitting changes only to numeric `width:` property values. */
function propertyName(node: ts.PropertyName | undefined): string | null {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) ? node.text : null;
}

function callParts(expression: ts.Expression): string[] {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) return [...callParts(expression.expression), expression.name.text];
  if (ts.isCallExpression(expression)) return callParts(expression.expression);
  return [];
}

function pageViewportCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "page"
    && node.expression.name.text === "setViewportSize";
}

function viewportCallInfo(call: ts.CallExpression): { width: number; position: number } | null {
  const argument = call.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return null;
  const properties = argument.properties;
  const widthProperties = properties.filter((item): item is ts.PropertyAssignment =>
    ts.isPropertyAssignment(item) && propertyName(item.name) === "width");
  const widthDefinitions = properties.filter((item) =>
    (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)
      || ts.isGetAccessorDeclaration(item) || ts.isSetAccessorDeclaration(item) || ts.isMethodDeclaration(item))
    && propertyName(item.name) === "width");
  const ambiguous = properties.some((item) => ts.isSpreadAssignment(item)
    || "name" in item && item.name !== undefined && ts.isComputedPropertyName(item.name))
    || widthDefinitions.length !== 1;
  const width = widthProperties.length === 1 ? widthProperties[0] : undefined;
  return !ambiguous && width && ts.isNumericLiteral(width.initializer)
    ? { width: Number(width.initializer.text), position: width.initializer.getStart() } : null;
}

function statementViewportCall(statement: ts.Statement): ts.CallExpression | null {
  if (!ts.isExpressionStatement(statement)) return null;
  if (!ts.isAwaitExpression(statement.expression)) return null;
  return pageViewportCall(statement.expression.expression) ? statement.expression.expression : null;
}

function directExpectSpan(statement: ts.Statement): { start: number; end: number } | null {
  if (!ts.isExpressionStatement(statement)) return null;
  const expression = ts.isAwaitExpression(statement.expression) ? statement.expression.expression : statement.expression;
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)
    || !/^to[A-Z]/.test(expression.expression.name.text)) return null;
  const expectRoot = (node: ts.Expression): ts.CallExpression | null => {
    if (ts.isPropertyAccessExpression(node)) return expectRoot(node.expression);
    if (!ts.isCallExpression(node)) return null;
    if (ts.isIdentifier(node.expression)) return node.expression.text === "expect" ? node : null;
    return ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "expect"
      && node.expression.name.text === "soft" ? node : null;
  };
  const root = expectRoot(expression.expression.expression);
  return root ? { start: root.getStart(), end: expression.getEnd() } : null;
}

function safeLiteral(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isRegularExpressionLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
  if (ts.isParenthesizedExpression(node)) return safeLiteral(node.expression);
  if (ts.isPrefixUnaryExpression(node)) return safeLiteral(node.operand);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) =>
    !ts.isSpreadElement(element) && safeLiteral(element));
  if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) =>
    ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && safeLiteral(property.initializer));
  return false;
}

function safeLocator(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (!/^(?:locator|getBy(?:Role|Text|LabelText|TestId|PlaceholderText|AltText|Title|DisplayValue))$/.test(node.expression.name.text)) return false;
  const receiver = node.expression.expression;
  return node.arguments.every(safeLiteral) && (ts.isIdentifier(receiver) && receiver.text === "page"
    || ts.isCallExpression(receiver) && safeLocator(receiver));
}

function safePrelude(statement: ts.Statement): boolean {
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.every((declaration) =>
    ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
    && (safeLiteral(declaration.initializer) || safeLocator(declaration.initializer)));
}

function viewportCallCount(node: ts.Node): number {
  let count = 0;
  const visit = (child: ts.Node): void => {
    if (pageViewportCall(child)) count += 1;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return count;
}

/** Module/test callback ranges whose own parsed body establishes responsive intent and viewport setup. */
export function responsiveTestRanges(
  file: string,
  source: string,
): Array<{ start: number; end: number; caseName: string; setupText: string }> | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  const ranges: Array<{ start: number; end: number; caseName: string; setupText: string }> = [];
  const fileResponsive = /(?:narrow|mobile)/i.test(file);
  const walk = (node: ts.Node, suiteResponsive: boolean): void => {
    ts.forEachChild(node, (child) => {
      if (!ts.isCallExpression(child)) { walk(child, suiteResponsive); return; }
      const parts = callParts(child.expression);
      const root = parts[0] ?? null;
      const callback = child.arguments.find((argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
      const titleNode = child.arguments.find((argument) => ts.isStringLiteral(argument)
        || ts.isNoSubstitutionTemplateLiteral(argument));
      const title = titleNode && (ts.isStringLiteral(titleNode) || ts.isNoSubstitutionTemplateLiteral(titleNode))
        ? titleNode.text : "";
      if ((root === "describe" || root === "test" && parts.includes("describe")) && callback) {
        walk(callback.body, suiteResponsive || fileResponsive || /(?:narrow|mobile)/i.test(title));
        return;
      }
      if (["it", "test"].includes(root ?? "") && callback) {
        const body = ts.isBlock(callback.body) ? callback.body : null;
        const setupStatements = body?.statements.map((statement, index) => ({ statement, index, call: statementViewportCall(statement) }))
          .filter((entry): entry is { statement: ts.Statement; index: number; call: ts.CallExpression } => entry.call !== null) ?? [];
        const setup = setupStatements.length === 1 ? setupStatements[0] : undefined;
        const info = setup ? viewportCallInfo(setup.call) : null;
        if ((fileResponsive || suiteResponsive || /(?:narrow|mobile)/i.test(title)) && body && setup && info
          && setup.index === 0 && info.width <= 600 && viewportCallCount(body) === 1) {
          for (const statement of body.statements.slice(setup.index + 1)) {
            const assertion = directExpectSpan(statement);
            if (!assertion) {
              if (safePrelude(statement)) continue;
              break;
            }
            ranges.push({ start: assertion.start, end: assertion.end, caseName: title || "responsive test",
              setupText: setup.statement.getText(tree) });
          }
        }
        return;
      }
      walk(child, suiteResponsive);
    });
  };
  walk(tree, false);
  return ranges;
}

/** Exact argument span for the expect/expect.soft call that starts at one matcher position. */
export function expectArgumentSpan(
  file: string,
  source: string,
  matcherStart: number,
): { start: number; end: number } | null {
  const kind = scriptKind(file);
  if (kind === null) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  let span: { start: number; end: number } | null = null;
  const visit = (node: ts.Node): void => {
    if (span) return;
    if (ts.isCallExpression(node) && node.getStart(tree) === matcherStart) {
      const direct = ts.isIdentifier(node.expression) && node.expression.text === "expect";
      const soft = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "expect"
        && node.expression.name.text === "soft";
      const argument = node.arguments[0];
      if ((direct || soft) && argument) {
        span = { start: argument.getStart(tree), end: argument.getEnd() };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return span;
}

function viewportWidthSnapshot(source: string): { widths: number[]; fingerprint: string } | null {
  const wrapped = `function proof() {\n${source}\n}`;
  const tree = ts.createSourceFile("responsive-proof.ts", wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  const positions = new Set<number>();
  const widths: number[] = [];
  let invalid = false;
  const visit = (node: ts.Node): void => {
    if (pageViewportCall(node)) {
      const info = viewportCallInfo(node);
      if (info) {
        positions.add(info.position);
        widths.push(info.width);
      } else invalid = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (invalid) return null;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, wrapped);
  const tokens: Array<{ kind: ts.SyntaxKind; text: string }> = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push({ kind: token, text: positions.has(scanner.getTokenPos()) ? "<viewport-width>" : scanner.getTokenText() });
  }
  return { widths, fingerprint: JSON.stringify(tokens) };
}

/** Exact viewport-width mutation: only owned numeric viewport widths may differ. */
export function viewportWidthMutation(before: string, after: string): boolean | null {
  const oldSnapshot = viewportWidthSnapshot(before);
  const newSnapshot = viewportWidthSnapshot(after);
  if (!oldSnapshot || !newSnapshot) return null;
  return oldSnapshot.widths.length > 0 && oldSnapshot.widths.length === newSnapshot.widths.length
    && oldSnapshot.widths.every((width) => width <= 600)
    && newSnapshot.widths.every((width) => width >= 768)
    && oldSnapshot.fingerprint === newSnapshot.fingerprint;
}
