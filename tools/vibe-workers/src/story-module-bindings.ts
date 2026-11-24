import * as ts from "typescript";

export const UNKNOWN = Symbol("unresolved CSF value");
export type Field = ts.Expression | ts.FunctionDeclaration | ts.MethodDeclaration | typeof UNKNOWN | undefined;
type Write = { at: number; value: Field };
type Scope = Map<string, Write[]>;
type Mutation = Write & { key?: string; spread?: boolean };

/** Runtime-transparent TS wrappers preserve both an expression's value and effects. */
export function transparentOperand(node: ts.Node): ts.Expression | undefined {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) ? node.expression : undefined;
}

/** Read snapshot operands at initialization and live exports after module evaluation, without executing user code. */
export function storyModuleBindings(tree: ts.SourceFile) {
  const moduleScope: Scope = new Map();
  const scopes = new WeakMap<ts.Node, Scope>();
  const imports = new Map<string, ts.Identifier>();
  const properties = new Map<ts.Node, Mutation[]>();
  const exports = new Map<string,string>();
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
        if (!ts.isIdentifier(item.name)) continue;
        if (row.declarationList.flags & ts.NodeFlags.BlockScoped) scope.set(item.name.text, []);
        else {
          const cell=moduleScope.get(item.name.text) ?? [];
          moduleScope.set(item.name.text,cell);
          scope.set(item.name.text,cell);
        }
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
    const inner=transparentOperand(input);
    if (inner) return resolve(inner,seen);
    if (isObjectCopy(input)) return resolve(input.arguments[0],new Set([...seen,input]));
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
  function isObjectCopy(expr:ts.Node):expr is ts.CallExpression {
    return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
      && expr.expression.name.text==="assign" && ts.isIdentifier(expr.expression.expression)
      && expr.expression.expression.text==="Object" && !scopeAt(expr).has("Object") && !imports.has("Object");
  }
  function effects(expr:ts.Expression,uncertain:boolean) {
    const inner=transparentOperand(expr);
    if(inner) {effects(inner,uncertain);return}
    if(!ts.isCallExpression(expr)) return;
    // Call arguments execute left to right before the receiver's own copy.
    effects(expr.expression,uncertain);
    for(const arg of expr.arguments) effects(arg,uncertain);
    if(isObjectCopy(expr) && expr.arguments[0]) for(const source of expr.arguments.slice(1)) {
      mutate(expr.arguments[0],{spread:true,value:uncertain ? UNKNOWN : source,at:expr.end});
    }
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
    function write(name:string,value:Field,at:number) {
      const cell=scope.get(name);
      if(!cell) return;
      cell.push({at,value:uncertain ? UNKNOWN : value});
      if(cell===moduleScope.get(name)){
        const names=changed.get(root) ?? new Set<string>();
        names.add(name);changed.set(root,names);
      }
    }
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
        if(item.initializer) {
          effects(item.initializer,uncertain);
          write(item.name.text,item.initializer,item.end);
        }
      }
    } else if (ts.isExpressionStatement(row)) {
      const expr = row.expression;
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        effects(expr.right,uncertain);
        const value = uncertain ? UNKNOWN : expr.right;
        if (ts.isIdentifier(expr.left)) {
          write(expr.left.text,value,row.end);
        } else if (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) {
          mutate(expr.left.expression, { key: propertyKey(expr.left), value, at: row.end });
        }
      } else effects(expr,uncertain);
    }
  }
  declare(moduleScope, tree.statements);
  for (const row of tree.statements) if (ts.isImportDeclaration(row)) {
    if (row.importClause?.name) imports.set(row.importClause.name.text, row.importClause.name);
    const named = row.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const item of named.elements) imports.set(item.name.text, item.name);
  }
  for(const row of tree.statements){
    if(ts.isExportDeclaration(row) && !row.isTypeOnly && !row.moduleSpecifier && row.exportClause && ts.isNamedExports(row.exportClause)){
      for(const spec of row.exportClause.elements) if(!spec.isTypeOnly) exports.set(spec.name.text,(spec.propertyName??spec.name).text);
    }
    if(!ts.canHaveModifiers(row) || !ts.getModifiers(row)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) continue;
    if(ts.isFunctionDeclaration(row) && row.name) exports.set(row.name.text,row.name.text);
    if(ts.isVariableStatement(row)) for(const decl of row.declarationList.declarations) if(ts.isIdentifier(decl.name)) exports.set(decl.name.text,decl.name.text);
  }
  for (const row of tree.statements) visit(row, moduleScope, false, row);

  function field(input: Field, key: string, seen = new Set<ts.Node>(), at = Infinity, reads = new Set<string>()): Field {
    const node = resolve(input, seen);
    if (!node || node === UNKNOWN) return node;
    const state=node.pos+":"+node.end+":"+key+":"+at;
    if(reads.has(state)) return UNKNOWN;
    const nextReads=new Set([...reads,state]);
    let result: Field;
    if (ts.isObjectLiteralExpression(node)) for (const member of node.properties) {
      if (ts.isSpreadAssignment(member)) {
        const inherited = field(member.expression, key, seen, member.end, nextReads);
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
        const copied = field(write.value, key, seen, write.at - 1,nextReads);
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
  function blockLocals(node:ts.Node):[string,Field][] {
    const scope=scopeAt(node);
    return [...scope].filter(([name,cell])=>cell!==moduleScope.get(name))
      .map(([name])=>[name,resolve(binding(name,scope,Infinity))]);
  }
  return { resolve, final, field, updates, blockLocals, scopeAt, exports, exported:(name:string)=>exports.has(name)?final(exports.get(name)!):UNKNOWN };
}
