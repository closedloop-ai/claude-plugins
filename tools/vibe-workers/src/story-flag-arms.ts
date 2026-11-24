import * as ts from "typescript";
import { storyRenderer } from "./story-render.js";
import { registeredStoryNames } from "./story-registration.js";

type Arm = "on" | "off" | "unknown";
import { storyModuleBindings, UNKNOWN, type Field } from "./story-module-bindings.js";

/** Evaluate only the effective provider setting on registered stories, without executing story code. */
export function storyFlagArms(source: string, flag: { name: string; key: string },
  importedFlag: (module: string, name: string) => boolean = () => false, exportedNames?: string[],
  ownerImport?: (module: string, symbol: string, children?: boolean, callOnly?: boolean, forwarding?: boolean, decorator?: boolean) => boolean): Arm[] {
  const tree = ts.createSourceFile("stories.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const {resolve,final,field}=storyModuleBindings(tree);
  const importedKeys = new Set<string>();
  const stories = new Set<string>();
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
      stories.add(statement.name.text);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const item of statement.declarationList.declarations) {
      if (!ts.isIdentifier(item.name) || !item.initializer) continue;
      if (exported && /^[A-Z]/.test(item.name.text)) stories.add(item.name.text);
    }
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
    const story = final(name);
    const node = resolve(story);
    const fn = node && node !== UNKNOWN && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) ? node : undefined;
    const render = fn ?? field(story,"render") ?? field(meta,"render") ?? field(meta,"component");
    const argument = (key: string) => field(field(story,"args"),key) ?? field(field(meta,"args"),key);
    const renderArgument = (key: string) => {
      const node = resolve(argument(key));
      return node === UNKNOWN || (node && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))) ? null : node;
    };
    if (renders && (render === UNKNOWN || !renders(render,false,false,false,renderArgument) || !forwards(field(meta,"decorators")) || !forwards(field(story,"decorators")))) return "unknown";
    const settings = field(story,"parameters");
    const flags = field(field(settings,"appCore"),"enabledFlags") ?? metaFlags;
    const effective = returnedFlags(field(settings,"appCoreFromArgs") ?? metaCallback, argument) ?? flags;
    return effective === undefined ? "off" : membership(effective);
  });
}
