import * as ts from "typescript";

/** Resolve the static CSF include/exclude selectors before counting exported stories. */
export function registeredStoryNames(source: string, names: string[], display = false): string[] {
  const tree = ts.createSourceFile("stories.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const locals = new Map<string, ts.Expression>();
  let meta: ts.Expression | undefined;
  for (const row of tree.statements) {
    if (ts.isExportAssignment(row)) meta = row.expression;
    if (ts.isVariableStatement(row)) for (const item of row.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.initializer) locals.set(item.name.text, item.initializer);
    }
  }
  function resolve(node: ts.Expression | undefined, seen = new Set<string>()): ts.Expression | undefined {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return resolve(node.expression, seen);
    if (!ts.isIdentifier(node)) return node;
    if (!seen.has(node.text)) return resolve(locals.get(node.text), new Set([...seen, node.text]));
  }
  function matches(node: ts.Expression | undefined, name: string): boolean | undefined {
    if (!node) return undefined;
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
  if (!object || !ts.isObjectLiteralExpression(object)) return meta ? [] : names;
  function collect(node: ts.ObjectLiteralExpression, seen: Set<ts.ObjectLiteralExpression>, fields: Map<string, ts.Expression>): boolean {
    if (seen.has(node)) return false;
    for (const item of node.properties) {
      if (ts.isSpreadAssignment(item)) {
        const base = resolve(item.expression);
        if (!base || !ts.isObjectLiteralExpression(base) || !collect(base, new Set([...seen, node]), fields)) return false;
      } else if (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) {
        if (ts.isComputedPropertyName(item.name)) return false;
        fields.set(item.name.getText(tree).replace(/^["']|["']$/g, ""), ts.isPropertyAssignment(item) ? item.initializer : item.name);
      }
    }
    return true;
  }
  const selectors = new Map<string, ts.Expression>();
  if (!collect(object, new Set(), selectors)) return [];
  const include = selectors.get("includeStories");
  const exclude = selectors.get("excludeStories");
  const registered = names.filter(name => (!include || matches(resolve(include), name) === true) && (!exclude || matches(resolve(exclude), name) === false));
  if (!display) return registered;
  return registered.flatMap(name => {
    const story = resolve(locals.get(name));
    if (!story || !ts.isObjectLiteralExpression(story)) return [name];
    const fields = new Map<string, ts.Expression>();
    if (!collect(story, new Set(), fields)) return [];
    if (!fields.has("name")) return [name];
    const label = resolve(fields.get("name"));
    return label && ts.isStringLiteralLike(label) ? [label.text] : [];
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
