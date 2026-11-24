import * as ts from "typescript";
import { storyRenderer } from "./story-render.js";
import { registeredStoryNames } from "./story-registration.js";

type Arm = "on" | "off" | "unknown";
const UNKNOWN = Symbol("unresolved");
type Field = ts.Expression | typeof UNKNOWN | undefined;

/** Evaluate only the effective provider setting on registered stories, without executing story code. */
export function storyFlagArms(source: string, flag: { name: string; key: string },
  importedFlag: (module: string, name: string) => boolean = () => false, exportedNames?: string[],
  ownerImport?: (module: string, symbol: string, children?: boolean, callOnly?: boolean, forwarding?: boolean, decorator?: boolean) => boolean): Arm[] {
  const tree = ts.createSourceFile("stories.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const locals = new Map<string, ts.Expression>();
  const importedKeys = new Set<string>();
  const stories = new Map<string, Field>();
  const functions = new Map<string, ts.FunctionDeclaration>();
  let meta: Field;
  for (const statement of tree.statements) {
    if (ts.isExportAssignment(statement)) meta = statement.expression;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const names = statement.importClause?.namedBindings;
      if (names && ts.isNamedImports(names)) for (const member of names.elements) {
        if (importedFlag(statement.moduleSpecifier.text, (member.propertyName ?? member.name).text)) importedKeys.add(member.name.text);
      }
    }
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isFunctionDeclaration(statement) && statement.name) {
      stories.set(statement.name.text, undefined);
      functions.set(statement.name.text,statement);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const item of statement.declarationList.declarations) {
      if (!ts.isIdentifier(item.name) || !item.initializer) continue;
      locals.set(item.name.text, item.initializer);
      if (exported && /^[A-Z]/.test(item.name.text)) stories.set(item.name.text, item.initializer);
    }
  }

  function resolve(node: Field, seen = new Set<string>()): Field {
    if (!node || node === UNKNOWN) return node;
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return resolve(node.expression, seen);
    if (!ts.isIdentifier(node)) return node;
    if (seen.has(node.text)) return UNKNOWN;
    const next = locals.get(node.text);
    return next ? resolve(next, new Set([...seen,node.text])) : importedKeys.has(node.text) ? node : UNKNOWN;
  }

  // Associate property writes with the actual object initializer, so aliases share the final CSF fields.
  const writes = new Map<ts.Node,Map<string, Field>>();
  for (const row of tree.statements) {
    if (!ts.isExpressionStatement(row) || !ts.isBinaryExpression(row.expression)) continue;
    const expression = row.expression, left = expression.left;
    if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) continue;
    const target = resolve(left.expression);
    if (!target || target === UNKNOWN) continue;
    const key = ts.isPropertyAccessExpression(left) ? left.name.text
      : ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : undefined;
    if (!key || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const fields = writes.get(target) ?? new Map<string,Field>();
    fields.set(key,expression.right);
    writes.set(target,fields);
  }

  function field(input: Field, key: string, seen = new Set<ts.Node>()): Field {
    const node = resolve(input);
    if (!node || node === UNKNOWN) return node;
    const written = writes.get(node)?.get(key);
    if (written !== undefined) return written;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return undefined;
    if (!ts.isObjectLiteralExpression(node) || seen.has(node)) return UNKNOWN;
    let value: Field;
    for (const member of node.properties) {
      if (ts.isSpreadAssignment(member)) {
        const from = field(member.expression, key, new Set([...seen,node]));
        if (from !== undefined) value = from;
      } else if (!member.name || ts.isComputedPropertyName(member.name)) value = UNKNOWN;
      else if (member.name.getText(tree).replace(/^["']|["']$/g,"") === key) {
        value = ts.isPropertyAssignment(member) ? member.initializer : ts.isShorthandPropertyAssignment(member) ? member.name : UNKNOWN;
      }
    }
    return value;
  }

  function membership(input: Field, seen = new Set<ts.Node>()): Arm {
    const node = resolve(input);
    if (!node || node === UNKNOWN || !ts.isArrayLiteralExpression(node) || seen.has(node)) return "unknown";
    let arm: Arm = "off";
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const nested = membership(element.expression, new Set([...seen,node]));
        if (nested === "on") return nested;
        if (nested === "unknown") arm = nested;
      } else {
        const item = resolve(element);
        if (!item || item === UNKNOWN) arm = "unknown";
        else if (ts.isIdentifier(item) && importedKeys.has(item.text)) return "on";
        else if (ts.isStringLiteralLike(item)) { if (item.text === flag.key) return "on"; }
        else arm = "unknown";
      }
    }
    return arm;
  }

  function returnedFlags(input: Field, argument: (name: string) => Field): Field {
    const callback = resolve(input);
    if (!callback || callback === UNKNOWN) return callback;
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return UNKNOWN;
    const body = callback.body;
    const value = ts.isBlock(body) ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!)
      ? body.statements[0].expression : UNKNOWN : body;
    const result = resolve(field(value, "enabledFlags"));
    if (!result || result === UNKNOWN || !ts.isConditionalExpression(result)) return result;
    const param = callback.parameters[0]?.name;
    const condition = result.condition;
    let selector: Field = UNKNOWN;
    if (param && ts.isIdentifier(param) && ts.isPropertyAccessExpression(condition) && ts.isIdentifier(condition.expression)
      && condition.expression.text === param.text) selector = argument(condition.name.text);
    if (param && ts.isObjectBindingPattern(param) && ts.isIdentifier(condition)) {
      const binding = param.elements.find(item => ts.isIdentifier(item.name) && item.name.text === condition.text);
      if (binding && !binding.dotDotDotToken) selector = argument((binding.propertyName ?? binding.name).getText(tree)) ?? binding.initializer;
    }
    const selected = resolve(selector);
    if (!selected || selected === UNKNOWN) return UNKNOWN;
    if (selected.kind === ts.SyntaxKind.TrueKeyword) return result.whenTrue;
    if (selected.kind === ts.SyntaxKind.FalseKeyword) return result.whenFalse;
    return UNKNOWN;
  }

  const renders = ownerImport && storyRenderer(tree, ownerImport);
  const mountsStory = ownerImport && storyRenderer(tree,(mod,symbol,children,called,decorator) =>
    (!!children || !!decorator) && ownerImport(mod,symbol,children,called,true,decorator));
  function forwards(input: Field, seen = new Set<ts.Node>()): boolean {
    if (input === undefined) return true;
    const array = resolve(input);
    if (!array || array === UNKNOWN || !ts.isArrayLiteralExpression(array) || seen.has(array)) return false;
    return array.elements.every(item => {
      if (ts.isSpreadElement(item)) return forwards(item.expression, new Set([...seen,array]));
      return !!mountsStory?.(item,false,false,true);
    });
  }
  const parameters = field(meta, "parameters");
  const metaFlags = field(field(parameters,"appCore"),"enabledFlags");
  const metaCallback = field(parameters,"appCoreFromArgs");
  return registeredStoryNames(source, exportedNames ?? [...stories.keys()]).map(name => {
    if (!stories.has(name)) return "unknown";
    const story = stories.get(name);
    const node = resolve(story);
    const fn = functions.get(name) ?? (node && node !== UNKNOWN && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) ? node : undefined);
    const render = fn ?? field(story,"render") ?? field(meta,"render") ?? field(meta,"component");
    const argument = (key: string) => field(field(story,"args"),key) ?? field(field(meta,"args"),key);
    const renderArgument = (key: string) => {
      const node = resolve(argument(key));
      return node === UNKNOWN ? undefined : node;
    };
    if (renders && (render === UNKNOWN || !renders(render,false,false,false,renderArgument) || !forwards(field(meta,"decorators")) || !forwards(field(story,"decorators")))) return "unknown";
    const settings = field(story,"parameters");
    const flags = field(field(settings,"appCore"),"enabledFlags") ?? metaFlags;
    const effective = returnedFlags(field(settings,"appCoreFromArgs") ?? metaCallback, argument) ?? flags;
    return effective === undefined ? "off" : membership(effective);
  });
}
