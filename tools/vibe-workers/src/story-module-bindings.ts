import * as ts from "typescript";

export const UNKNOWN = Symbol("unresolved CSF value");
export type Field = ts.Expression | ts.FunctionDeclaration | ts.MethodDeclaration | typeof UNKNOWN | undefined;
type Write = { at: number; value: Field };
type Scope = Map<string, Write[]>;
type Mutation = Write & { key?: string; spread?: boolean };

/** Read snapshot operands at initialization and live exports after module evaluation, without executing user code. */
export function storyModuleBindings(tree: ts.SourceFile) {
  const moduleScope: Scope = new Map();
  const scopes = new WeakMap<ts.Node, Scope>();
  const imports = new Map<string, ts.Identifier>();
  const properties = new Map<ts.Node, Mutation[]>();
  const changed = new Map<ts.Statement, Set<string>>();

  function scopeAt(node: ts.Node): Scope {
    for (let at: ts.Node | undefined = node; at; at = at.parent) {
      const scope = scopes.get(at);
      if (scope) return scope;
    }
    return moduleScope;
  }
  function declare(scope: Scope, rows: readonly ts.Statement[]) {
    for (const row of rows) {
      if (ts.isFunctionDeclaration(row) && row.name) scope.set(row.name.text, [{ at: -1, value: row }]);
      if (ts.isVariableStatement(row)) for (const item of row.declarationList.declarations) {
        if (ts.isIdentifier(item.name)) scope.set(item.name.text, []);
      }
    }
  }
  function binding(name: string, scope: Scope, at: number): Field {
    const cell = scope.get(name);
    return cell ? cell.filter(entry => entry.at <= at).at(-1)?.value ?? UNKNOWN : imports.get(name) ?? UNKNOWN;
  }
  function resolve(input: Field, seen = new Set<ts.Node>()): Field {
    if (!input || input === UNKNOWN) return input;
    if (seen.has(input)) return UNKNOWN;
    if (ts.isParenthesizedExpression(input) || ts.isAsExpression(input) || ts.isSatisfiesExpression(input)) return resolve(input.expression, seen);
    if (ts.isIdentifier(input)) {
      const bound = binding(input.text, scopeAt(input), input.pos);
      return bound === input ? input : resolve(bound, new Set([...seen, input]));
    }
    if (ts.isPropertyAccessExpression(input) || ts.isElementAccessExpression(input)) {
      const key = propertyKey(input);
      return key === undefined ? UNKNOWN : resolve(field(input.expression, key, new Set([...seen, input]), input.pos), new Set([...seen, input]));
    }
    return input;
  }
  function propertyKey(node: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
    return ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  }
  function final(name: string): Field { return resolve(binding(name, moduleScope, Infinity)); }
  function truth(expr: ts.Expression): boolean | undefined {
    const node = resolve(expr);
    if (!node || node === UNKNOWN) return undefined;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = truth(node.operand);
      return operand === undefined ? undefined : !operand;
    }
  }
  function mutate(receiver: ts.Expression, write: Mutation) {
    const target = resolve(receiver);
    if (!target || target === UNKNOWN) return;
    const mutations = properties.get(target) ?? [];
    mutations.push(write);
    properties.set(target, mutations);
  }
  function visit(row: ts.Statement, scope: Scope, uncertain: boolean, root: ts.Statement) {
    scopes.set(row, scope);
    if (ts.isBlock(row)) {
      const local = new Map(scope);
      declare(local, row.statements);
      for (const stmt of row.statements) visit(stmt, local, uncertain, root);
    } else if (ts.isIfStatement(row)) {
      const known = truth(row.expression);
      if (known !== false) visit(row.thenStatement, scope, uncertain || known === undefined, root);
      if (row.elseStatement && known !== true) visit(row.elseStatement, scope, uncertain || known === undefined, root);
    } else if (ts.isVariableStatement(row)) {
      for (const item of row.declarationList.declarations) if (ts.isIdentifier(item.name)) {
        scope.get(item.name.text)?.push({ at: item.end, value: uncertain ? UNKNOWN : item.initializer });
      }
    } else if (ts.isExpressionStatement(row)) {
      const expr = row.expression;
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const value = uncertain ? UNKNOWN : expr.right;
        if (ts.isIdentifier(expr.left)) {
          const name = expr.left.text, cell = scope.get(name);
          cell?.push({ at: row.end, value });
          if (cell && cell === moduleScope.get(name)) {
            const names = changed.get(root) ?? new Set<string>();
            names.add(name);
            changed.set(root, names);
          }
        } else if (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) {
          mutate(expr.left.expression, { key: propertyKey(expr.left), value, at: row.end });
        }
      } else if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
        && expr.expression.name.text === "assign" && ts.isIdentifier(expr.expression.expression)
        && expr.expression.expression.text === "Object" && !scope.has("Object") && !imports.has("Object") && expr.arguments[0]) {
        for (const source of expr.arguments.slice(1)) {
          mutate(expr.arguments[0], { spread: true, value: uncertain ? UNKNOWN : source, at: row.end });
        }
      }
    }
  }
  declare(moduleScope, tree.statements);
  for (const row of tree.statements) if (ts.isImportDeclaration(row)) {
    if (row.importClause?.name) imports.set(row.importClause.name.text, row.importClause.name);
    const named = row.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const item of named.elements) imports.set(item.name.text, item.name);
  }
  for (const row of tree.statements) visit(row, moduleScope, false, row);

  function field(input: Field, key: string, seen = new Set<ts.Node>(), at = Infinity): Field {
    const node = resolve(input, seen);
    if (!node || node === UNKNOWN) return node;
    if (seen.has(node)) return UNKNOWN;
    const next = new Set([...seen, node]);
    let result: Field;
    if (ts.isObjectLiteralExpression(node)) for (const member of node.properties) {
      if (ts.isSpreadAssignment(member)) {
        const inherited = field(member.expression, key, next, member.end);
        if (inherited !== undefined) result = inherited;
      } else if (!member.name || ts.isComputedPropertyName(member.name)) result = UNKNOWN;
      else if (member.name.getText(tree).replace(/^["']|["']$/g, "") === key) {
        result = ts.isPropertyAssignment(member) ? member.initializer : ts.isShorthandPropertyAssignment(member) ? member.name : ts.isMethodDeclaration(member) ? member : UNKNOWN;
      }
    }
    else if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) return UNKNOWN;
    for (const write of properties.get(node) ?? []) {
      if (write.at > at) break;
      if (write.spread) {
        if (resolve(write.value) === node) continue;
        const copied = field(write.value, key, next, write.at - 1);
        if (copied !== undefined) result = copied;
      } else if (write.key === key) result = write.value;
      else if (write.key === undefined) result = UNKNOWN;
    }
    return result;
  }
  /** Reachable writes in a compound module statement, as observed by closures after that statement. */
  function updates(row: ts.Statement): [string, Field][] {
    return [...changed.get(row) ?? []].map(name => [name, resolve(binding(name, moduleScope, row.end))]);
  }
  return { resolve, final, field, updates };
}
