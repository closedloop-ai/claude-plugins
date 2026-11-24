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
    if (ts.isBinaryExpression(input) && input.operatorToken.kind === ts.SyntaxKind.EqualsToken) return resolve(input.right,seen);
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
    function write(name:string,value:Field,at:number,conditional=uncertain) {
      const cell=scope.get(name);
      if(!cell) return;
      cell.push({at,value:conditional ? UNKNOWN : value});
      if(cell===moduleScope.get(name)){
        const names=changed.get(root) ?? new Set<string>();
        names.add(name);changed.set(root,names);
      }
    }
    // Only evaluated operands have effects. Function bodies remain dormant until called.
    function effects(expr: ts.Expression, conditional=uncertain): void {
      const inner = transparentOperand(expr);
      if (inner) return effects(inner,conditional);
      if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
        effects(expr.expression,conditional);
        if (ts.isElementAccessExpression(expr)) effects(expr.argumentExpression,conditional);
      } else if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        effects(expr.left,conditional);
        effects(expr.right,conditional);
        const target = transparentOperand(expr.left) ?? expr.left;
        if (ts.isIdentifier(target)) write(target.text, expr.right, expr.end,conditional);
        else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
          mutate(target.expression, { key: propertyKey(target), value: conditional ? UNKNOWN : expr.right, at: expr.end });
      } else if (ts.isConditionalExpression(expr)) {
        effects(expr.condition,conditional);
        const known=truth(expr.condition);
        if (known!==false) effects(expr.whenTrue,conditional || known===undefined);
        if (known!==true) effects(expr.whenFalse,conditional || known===undefined);
      } else if (ts.isBinaryExpression(expr)) {
        effects(expr.left,conditional);
        const op=expr.operatorToken.kind;
        const logical=op===ts.SyntaxKind.AmpersandAmpersandToken || op===ts.SyntaxKind.BarBarToken;
        if (logical) {
          const known=truth(expr.left);
          if (known===undefined || known===(op===ts.SyntaxKind.AmpersandAmpersandToken))
            effects(expr.right,conditional || known===undefined);
        } else if (op===ts.SyntaxKind.QuestionQuestionToken) {
          const left=resolve(expr.left);
          if (left===UNKNOWN || !left || left.kind===ts.SyntaxKind.NullKeyword) effects(expr.right,conditional || left===UNKNOWN);
        } else effects(expr.right,conditional);
      } else if (ts.isCallExpression(expr)) {
        effects(expr.expression,conditional);
        for (const argument of expr.arguments) effects(argument,conditional);
        if (isObjectCopy(expr) && expr.arguments[0]) for (const source of expr.arguments.slice(1))
          mutate(expr.arguments[0], {spread:true, value:conditional ? UNKNOWN : source, at:expr.end});
      } else if (ts.isObjectLiteralExpression(expr)) {
        for (const item of expr.properties) {
          if (item.name && ts.isComputedPropertyName(item.name)) effects(item.name.expression,conditional);
          if (ts.isPropertyAssignment(item)) effects(item.initializer,conditional);
          if (ts.isSpreadAssignment(item)) effects(item.expression,conditional);
        }
      } else if (ts.isArrayLiteralExpression(expr)) {
        for (const item of expr.elements) effects(ts.isSpreadElement(item) ? item.expression : item,conditional);
      }
    }
    if (ts.isBlock(row)) {
      const local = new Map(scope);
      declare(local, row.statements);
      for (const stmt of row.statements) visit(stmt, local, uncertain, root);
    } else if (ts.isIfStatement(row)) {
      effects(row.expression);
      const known = truth(row.expression);
      if (known !== false) visit(row.thenStatement, scope, uncertain || known === undefined, root);
      if (row.elseStatement && known !== true) visit(row.elseStatement, scope, uncertain || known === undefined, root);
    } else if (ts.isVariableStatement(row)) {
      for (const item of row.declarationList.declarations) if (ts.isIdentifier(item.name)) {
        if(item.initializer) {
          effects(item.initializer);
          write(item.name.text,item.initializer,item.end);
        }
      }
    } else if (ts.isExpressionStatement(row)) effects(row.expression);
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
    if(ts.getModifiers(row)?.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword)) continue;
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
  function blockLocals(node:ts.Node):[string,Write[],Field][] {
    const scope=scopeAt(node);
    return [...scope].filter(([name,cell])=>cell!==moduleScope.get(name))
      .map(([name,cell])=>[name,cell,resolve(binding(name,scope,Infinity))]);
  }
  return { resolve, final, field, updates, blockLocals, scopeAt, exports, exported:(name:string)=>exports.has(name)?final(exports.get(name)!):UNKNOWN };
}
