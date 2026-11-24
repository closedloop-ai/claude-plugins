import * as ts from "typescript";
import { flagBindings, type FlagImport } from "./story-flag-binding.js";


type OwnerImport = (module: string, symbol: string, children?: boolean, callOnly?: boolean, decorator?: boolean) => boolean;
type Fn = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;
type Scope = Map<string, symbol>;
type Store = Map<symbol, Value>;
type Value = { kind: "fn"; node: Fn; scope: Scope } | { kind: "expression"; node: ts.Node; scope: Scope }
  | { kind: "import"; module: string; name: string } | { kind: "children"; reached: boolean } | { kind: "props"; reached: boolean; get?: (key: string)=>Value } | {kind:"key" | "hook" | "unknown" | "absent"}
  | { kind: "story" } | { kind:"result"; rendered:boolean } | undefined;
type Mode = "render" | "execute" | "mount" | "call" | "returnCall" | "decorator";

function functionNode(node: ts.Node): node is Fn {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
}

/** Resolve actual callable values and mounted elements through lexical bindings. Unknown paths cannot prove an arm. */
export function storyRenderer(tree: ts.SourceFile, owner: OwnerImport, flag?: ReturnType<typeof flagBindings>, discovery = false) {
  const moduleScope: Scope = new Map();
  const moduleStore: Store = new Map();

  type Closure = Extract<Value,{kind:"fn"}>;
  let deferred: {ref:Closure; store:Store; ancestry:Set<Fn>}[] | undefined;
  let ancestry = new Set<Fn>();
  function callable(node:Fn,scope:Scope,store:Store):Closure {
    const ref:Closure={kind:"fn",node,scope};
    if (deferred && !ancestry.has(node) && !deferred.some(item=>item.ref.node===node && item.ref.scope===scope)) deferred.push({ref,store,ancestry});
    return ref;
  }

  function bind(scope: Scope, store: Store, name: string, value?: Value) {
    const cell = Symbol(name);
    scope.set(name, cell);
    store.set(cell, value);
  }

  // Hoist declarations and reserve local cells before following any return or branch.
  function enter(rows: readonly ts.Statement[], scope: Scope, store: Store) {
    for (const row of rows) {
      if (ts.isFunctionDeclaration(row) && row.name) bind(scope, store, row.name.text, callable(row,scope,store));
      if (ts.isVariableStatement(row)) for (const item of row.declarationList.declarations) {
        if (ts.isIdentifier(item.name)) bind(scope, store, item.name.text);
      }
    }
  }
  function lookup(name: string, scope: Scope, store: Store) {
    const cell = scope.get(name);
    return cell && store.get(cell);
  }
  const hookName = (name: string) => /^use(?:[A-Z]\w*)?FeatureFlag\w*$/.test(name);
  function isHook(fn: Value, key: Value) {
    return !!flag && (fn?.kind === "hook" || (fn?.kind === "import" && hookName(fn.name))) &&
      (key?.kind === "key" || (key?.kind === "import" && flag.key(key.module,key.name)));
  }
  function value(node: ts.Node | undefined, scope: Scope, store: Store): Value {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return value(node.expression,scope,store);
    if (ts.isIdentifier(node)) return scope.has(node.text) ? lookup(node.text,scope,store)
      : flag && hookName(node.text) ? {kind:"hook"} : undefined;
    if (ts.isPropertyAccessExpression(node)) {
      const base = value(node.expression,scope,store);
      if (base?.kind === "props") return base.get?.(node.name.text);
    }
    if (functionNode(node)) return callable(node,scope,store);

    // JSX and other ordinary initializer operands observe values at creation. Functions retain their declaration scope.
    const captured: Scope = new Map();
    for (const [name, cell] of scope) bind(captured,store,name,store.get(cell));
    return {kind:"expression",node,scope:captured};
  }
  function initialize(row: ts.VariableStatement, scope: Scope, store: Store, seen: Set<ts.Node>) {
    for (const item of row.declarationList.declarations) {
      const cell = ts.isIdentifier(item.name) && scope.get(item.name.text);
      const initial = item.initializer;
      const initialValue = evaluate(initial,scope,store,seen);
      if (cell) store.set(cell,flag?.declaration(item) ? {kind:"key"} : initialValue.value);
      if (initialValue.reached) return true;
    }
    return false;
  }
  enter(tree.statements,moduleScope,moduleStore);
  for (const row of tree.statements) {
    if (!ts.isImportDeclaration(row) || !ts.isStringLiteral(row.moduleSpecifier)) continue;
    const module = row.moduleSpecifier.text;
    if (row.importClause?.name) bind(moduleScope,moduleStore,row.importClause.name.text,{kind:"import",module,name:"default"});
    const bindings = row.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      bind(moduleScope,moduleStore,item.name.text,{kind:"import",module,name:(item.propertyName ?? item.name).text});
    }
  }


  function use(ref: Value, store: Store, mode: Mode, seen: Set<ts.Node>, children = false, args?: Value[]): boolean {
    if (!ref) return false;
    if (ref.kind === "result") return mode === "render" && ref.rendered;
    if (ref.kind === "story") return mode === "mount" || mode === "returnCall";
    if (ref.kind === "children") return mode === "render" && ref.reached;
    if (ref.kind === "props" || ref.kind === "hook" || ref.kind === "key") return false;
    if (ref.kind === "expression") return walk(ref.node,ref.scope,store,mode,seen,children);
    if (mode === "render" || mode === "execute") return false;
    if (ref.kind === "import") return owner(ref.module,ref.name,children,mode === "call",mode === "decorator");
    if (ref.kind !== "fn" || seen.has(ref.node)) return false;
    const scope = callScope(ref,store,mode,children,args);
    return walk(ref.node.body,scope,store,mode === "call" ? "execute" : "render",new Set([...seen,ref.node]));
  }

  function callScope(ref: Extract<Value,{kind:"fn"}>, store: Store, mode: Mode, children: boolean, args?: Value[]) {
    const scope = new Map(ref.scope);
    for (const [index,param] of ref.node.parameters.entries()) {
      if (ts.isIdentifier(param.name)) bind(scope,store,param.name.text,args ? args[index] : index === 0
        ? mode === "decorator" ? {kind:"story"} : {kind:"props", reached:children} : undefined);
      if (ts.isObjectBindingPattern(param.name)) for (const entry of param.name.elements) {
        if (!ts.isIdentifier(entry.name)) continue;
        const key = (entry.propertyName ?? entry.name).getText(tree);
        const props = args?.[index];
        const actual = props?.kind === "props" ? props.get?.(key) : undefined;
        const selected = actual?.kind === "absent" ? value(entry.initializer,scope,store) : actual;
        bind(scope,store,entry.name.text, selected ?? (key === "children" && index === 0 ? {kind:"children",reached:children} : undefined));
      }
    }
    return scope;
  }

  // Compute a local call once, capturing its actual return before running the next initializer or statement.
  function evaluate(node: ts.Node | undefined, scope: Scope, store: Store, seen: Set<ts.Node>): {value:Value; reached:boolean} {
    if (!node || seen.has(node)) return {value:undefined,reached:false};
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return evaluate(node.expression,scope,store,seen);
    if (ts.isCallExpression(node)) {
      const fn = value(node.expression,scope,store);
      const next = new Set([...seen,node]);
      const actual = node.arguments.map(arg=>evaluate(arg,scope,store,next));
      const reached = actual.some(arg=>arg.reached) || isHook(fn,actual[0]?.value);
      if (fn?.kind === "fn" && fn.node.body && !seen.has(fn.node)) {
        const local = callScope(fn,store,"returnCall",false,actual.map(arg=>arg.value));
        next.add(fn.node);
        if (!ts.isBlock(fn.node.body)) {
          const result = evaluate(fn.node.body,local,store,next);
          return {value:result.value,reached:reached || result.reached};
        }
        const returned: Value[] = [];
        const capture = (expr: ts.Expression | undefined, inner: Scope, state: Store) => {
          const result = evaluate(expr,inner,state,next);
          returned.push(result.value);
          return result.reached;
        };
        const executed = block(fn.node.body.statements,local,store,"execute",next,()=>{returned.push(undefined);return false;},capture);
        return {value:returned.every(item=>item===returned[0]) ? returned[0] : undefined,reached:reached || executed};
      }
      const args = actual.map(arg=>arg.value);
      return {value:{kind:"result",rendered:use(fn,store,"returnCall",next,false,args)},reached:reached || use(fn,store,"call",next,false,args)};
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const result = evaluate(node.right,scope,store,seen);
      const cell = scope.get(node.left.text);
      if (cell) store.set(cell,result.value);
      return result;
    }
    const reached = walk(node,scope,store,"execute",seen);
    return {value:value(node,scope,store),reached};
  }

  function truth(node: ts.Expression,scope: Scope,store: Store):boolean | undefined {
    if (ts.isParenthesizedExpression(node)) return truth(node.expression,scope,store);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const operand=truth(node.operand,scope,store);
      return operand===undefined ? undefined : !operand;
    }
    const ref = value(node,scope,store);
    if (ref?.kind !== "expression") return undefined;
    if (ts.isPrefixUnaryExpression(ref.node) && ref.node !== node) return truth(ref.node,ref.scope,store);
    if (ref.node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if ([ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.NullKeyword].includes(ref.node.kind)) return false;
    if (ts.isStringLiteralLike(ref.node)) return !!ref.node.text;
    if (ts.isNumericLiteral(ref.node)) return Number(ref.node.text) !== 0;
    return undefined;
  }
  function join(store: Store,yes: Store,no: Store) {
    for (const cell of store.keys()) store.set(cell,yes.get(cell) === no.get(cell) ? yes.get(cell) : undefined);
  }
  function walk(node: ts.Node | undefined, scope: Scope, store: Store, mode: Mode, seen: Set<ts.Node>, children = false): boolean {
    if (!node || seen.has(node)) return false;
    const next = new Set([...seen,node]);
    const read = (expr: ts.Node | undefined, kind: Mode = mode) => walk(expr,scope,store,kind,next);

    if (ts.isIdentifier(node)) return use(lookup(node.text,scope,store),store,mode,next,children);
    if (functionNode(node)) return use(callable(node,scope,store),store,mode,seen,children);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.name.text === "children") {
      const props = lookup(node.expression.text,scope,store);
      return mode === "render" && props?.kind === "props" && props.reached;
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isJsxExpression(node)) return read(node.expression);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (opening.attributes.properties.some(attr => read(ts.isJsxSpreadAttribute(attr) ? attr.expression : attr.initializer,"execute"))) return true;
      if (mode === "execute") return false;
      const nested = ts.isJsxElement(node) && node.children.some(child => read(child,"render"));
      const tag = opening.tagName;
      return ts.isIdentifier(tag) && /^[a-z]/.test(tag.text) ? nested : walk(tag,scope,store,"mount",next,nested);
    }
    if (ts.isJsxFragment(node)) return mode !== "execute" && node.children.some(child => read(child,"render"));
    if (ts.isPrefixUnaryExpression(node)) return read(node.operand,"execute");
    if (ts.isConditionalExpression(node)) {
      if (read(node.condition,"execute")) return true;
      const selected = truth(node.condition,scope,store);
      if (selected !== undefined) return read(selected ? node.whenTrue : node.whenFalse);
      const yes = new Map(store), no = new Map(store);
      const left = walk(node.whenTrue,scope,yes,mode,next);
      const right = walk(node.whenFalse,scope,no,mode,next);
      // Keep only bindings both execution paths establish for the continuation.
      join(store,yes,no);
      return discovery ? left || right : left && right;
    }
    if (ts.isCallExpression(node)) {
      const actual = node.arguments.map(arg=>evaluate(arg,scope,store,next));
      const fn = value(node.expression,scope,store);
      return isHook(fn,actual[0]?.value) || actual.some(arg=>arg.reached) || use(fn,store,mode === "execute" ? "call" : "returnCall",next,false,actual.map(arg=>arg.value));
    }
    if (ts.isBlock(node)) return block(node.statements,scope,store,mode,next);
    if (ts.isBinaryExpression(node)) {
      if (read(node.left,"execute")) return true;
      const op = node.operatorToken.kind;
      if (ts.isIdentifier(node.left) && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        const result = evaluate(node.right,scope,store,next);
        const cell = scope.get(node.left.text);
        if (cell) store.set(cell,op === ts.SyntaxKind.EqualsToken ? result.value : undefined);
        return result.reached || (mode === "render" && op === ts.SyntaxKind.EqualsToken && use(result.value,store,"render",next));
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        let left = node.left;
        while (ts.isParenthesizedExpression(left)) left = left.expression;
        const nil = left.kind === ts.SyntaxKind.NullKeyword;
        const known=truth(left,scope,store);
        const yes = known === true || ts.isJsxElement(left) || ts.isJsxSelfClosingElement(left);
        const no = known === false || nil;
        if (!yes && !no) return discovery ? read(left) || read(node.right) : read(left) && read(node.right);
        const useRight = op === ts.SyntaxKind.AmpersandAmpersandToken ? yes : op === ts.SyntaxKind.BarBarToken ? no : nil;
        return read(useRight ? node.right : left);
      }
      return read(node.right,"execute");
    }
    return false;
  }

  // Each lexical block gets new local cells. Its continuation receives the branch's writes to outer cells.
  function block(rows: readonly ts.Statement[], outer: Scope, initial: Store, mode: Mode, seen: Set<ts.Node>, finish: (store: Store)=>boolean = ()=>false, capture?: (expr:ts.Expression | undefined, inner:Scope, state:Store)=>boolean): boolean {
    const scope = new Map(outer);
    enter(rows,scope,initial);
    function sequence(index: number, store: Store): boolean {
      for (; index < rows.length; index++) {
        const row = rows[index]!;
        if (ts.isThrowStatement(row)) return false;
        if (ts.isReturnStatement(row)) return capture ? capture(row.expression,scope,store) : walk(row.expression,scope,store,mode,seen);
        const rest = (branch: Store) => sequence(index+1,branch);
        if (ts.isIfStatement(row)) {
          if (walk(row.expression,scope,store,"execute",seen)) return true;
          const branch = (stmt: ts.Statement | undefined, state: Store) => stmt ? block(ts.isBlock(stmt) ? stmt.statements : [stmt],scope,state,mode,seen,rest,capture) : rest(state);
          const selected = truth(row.expression,scope,store);
          if (selected !== undefined) return branch(selected ? row.thenStatement : row.elseStatement,store);
          const yes = new Map(store), no = new Map(store);
          const left = branch(row.thenStatement,yes);
          const right = branch(row.elseStatement,no);
          join(store,yes,no);
          return discovery ? left || right : left && right;
        }
        if (ts.isBlock(row)) return block(row.statements,scope,store,mode,seen,rest,capture);
        if (ts.isVariableStatement(row)) {
          if (initialize(row,scope,store,seen)) return true;
        } else if (ts.isExpressionStatement(row)) {
          if (walk(row.expression,scope,store,"execute",seen)) return true;
        } else if (!ts.isFunctionDeclaration(row) && !ts.isEmptyStatement(row)) return false;
      }
      return finish(store);
    }
    return sequence(0,initial);
  }
  return (node?: ts.Node, children = false, callOnly = false, decorator = false, argument?: (name: string)=>ts.Expression | null | undefined) => {
    if (!node) return false;
    ancestry=new Set();
    deferred=discovery ? [] : undefined;
    const store = new Map(moduleStore);
    let captured: Value;
    for (const row of tree.statements) {
      // Metadata operands capture values during initialization. Their callable closures read the final module cells.
      if (row.pos <= node.pos && node.end <= row.end) captured = value(node,moduleScope,store);
      if (ts.isVariableStatement(row)) initialize(row,moduleScope,store,new Set());
      if (ts.isExpressionStatement(row)) walk(row.expression,moduleScope,store,"execute",new Set());
    }
    const props: Value[] | undefined = argument ? [{kind:"props",reached:children,get:key=>{
      const expression=argument(key);
      return expression === undefined ? {kind:"absent"} : expression === null ? {kind:"unknown"} : value(expression,moduleScope,store);
    }}] : undefined;
    if (use(captured,store,decorator ? "decorator" : callOnly ? "call" : "mount",new Set(),children,props)) return true;
    // Discovery considers deferred handlers in the lexical activation that created them.
    for (const entry of deferred ?? []) {
      ancestry=new Set([...entry.ancestry,entry.ref.node]);
      if (use(entry.ref,new Map(entry.store),"call",new Set())) return true;
    }
    return false;
  };
}

/** Resolve the exact component export, including re-exports, and test its reachable rendering or hook calls. */
export function exportedStoryRenderer(source: string, symbol: string, flag: string, matchesFlag: FlagImport, imported: OwnerImport, owns: boolean, defines = false, children = false, callOnly = false, decorator = false) {
  const tree = ts.createSourceFile("component.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const renders = storyRenderer(tree,imported,owns ? flagBindings(tree,flag,defines,matchesFlag) : undefined);
  for (const stmt of tree.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      const binding = stmt.exportClause.elements.find(item => item.name.text === symbol && !item.isTypeOnly);
      if (binding) {
        const local = binding.propertyName ?? binding.name;
        return stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? imported(stmt.moduleSpecifier.text,local.text,children,callOnly,decorator) : renders(local,children,callOnly,decorator);
      }
    }
    if (ts.isExportAssignment(stmt) && symbol === "default") return renders(stmt.expression,children,callOnly,decorator);
    if (!ts.canHaveModifiers(stmt) || !ts.getModifiers(stmt)?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(stmt)) {
      const key = stmt.modifiers?.some(mod => mod.kind === ts.SyntaxKind.DefaultKeyword) ? "default" : stmt.name?.text;
      if (key === symbol) return renders(stmt,children,callOnly,decorator);
    }
    if (ts.isVariableStatement(stmt)) for (const item of stmt.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.name.text === symbol) return renders(item.initializer,children,callOnly,decorator);
    }
  }
  return false;
}

/** Discover consumers using the same executed flag and callee bindings as mounted story coverage. */
export function storyFlagBindings(source: string, name: string, defines: boolean, imported: FlagImport) {
  const tree = ts.createSourceFile("consumer.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const binding = flagBindings(tree,name,defines,imported);
  const run = storyRenderer(tree,()=>false,binding,true);
  const visit = (node: ts.Node): boolean => (functionNode(node) && run(node)) || ts.forEachChild(node,child=>visit(child) || undefined) === true;
  return {...binding,consumes:()=>visit(tree)};
}
