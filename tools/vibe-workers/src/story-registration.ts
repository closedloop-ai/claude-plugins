import * as ts from "typescript";
import { storyModuleBindings, UNKNOWN, type Field } from "./story-module-bindings.js";

/** Resolve the static CSF include/exclude selectors before counting exported stories. */
export function registeredStoryNames(source: string, names?: string[], display = false): string[] {
  const tree = ts.createSourceFile("stories.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { resolve, exported, field, exports }=storyModuleBindings(tree);
  const candidates = names ?? [...exports.keys()].filter(name => name !== "default" && name !== "__namedExportsOrder");
  const meta=tree.statements.find(ts.isExportAssignment)?.expression;
  function matches(node: Field, name: string): boolean | undefined {
    if (!node || node===UNKNOWN) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text === name;
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map(item => matches(resolve(item), name));
      return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
    }
    if (ts.isRegularExpressionLiteral(node)) {
      const text = node.text;
      const end = text.lastIndexOf("/");
      try { return new RegExp(text.slice(1, end), text.slice(end + 1)).test(name); } catch { return undefined; }
    }
  }
  const object = resolve(meta);
  if (!object || object===UNKNOWN || !ts.isObjectLiteralExpression(object)) return meta ? [] : candidates;
  const include=field(object,"includeStories"), exclude=field(object,"excludeStories");
  const registered = candidates.filter(name => (!include || matches(resolve(include), name) === true) && (!exclude || matches(resolve(exclude), name) === false));
  if (!display) return registered;
  return registered.flatMap(name => {
    const story = exported(name);
    if (story===UNKNOWN) return [];
    const label = resolve(field(story,"name"));
    if (label===undefined) return [name];
    return label!==UNKNOWN && ts.isStringLiteralLike(label) ? [label.text] : [];
  });
}

/** Read the declared Storybook collection globs without loading the configuration or running addons. */
export function storyCollectionGlobs(source: string): string[] {
  const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const locals = new Map<string,ts.Expression>();
  let config: ts.Expression | undefined;
  for (const row of tree.statements) {
    if (ts.isExportAssignment(row)) config = row.expression;
    if (ts.isVariableStatement(row)) for (const variable of row.declarationList.declarations) {
      if (ts.isIdentifier(variable.name) && variable.initializer) locals.set(variable.name.text,variable.initializer);
    }
  }
  function resolve(node: ts.Expression | undefined, seen = new Set<string>()): ts.Expression | undefined {
    if (!node) return;
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return resolve(node.expression, seen);
    if (!ts.isIdentifier(node)) return node;
    if (!seen.has(node.text)) return resolve(locals.get(node.text),new Set([...seen,node.text]));
  }
  const object = resolve(config);
  if (!object || !ts.isObjectLiteralExpression(object)) return [];
  const property = object.properties.find(member => member.name && member.name.getText(tree).replace(/^["']|["']$/g,"") === "stories");
  const array = property && ts.isPropertyAssignment(property) ? resolve(property.initializer) : undefined;
  return array && ts.isArrayLiteralExpression(array) ? array.elements.flatMap(member => {
    const value = resolve(member);
    return value && ts.isStringLiteralLike(value) ? [value.text] : [];
  }) : [];
}
