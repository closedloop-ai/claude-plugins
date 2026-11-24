import * as ts from "typescript";

export type FlagImport = (module: string, symbol: string) => boolean;

/** Resolve literal declarations, imports and exported aliases to the same defining flag. */
export function flagBindings(tree: ts.SourceFile, name: string, defines: boolean, imported: FlagImport) {
  const locals = new Map<string,ts.Expression | undefined>();
  const imports = new Map<string,[string,string]>();
  const exports = new Map<string,string | [string,string]>();
  for (const row of tree.statements) {
    if (ts.isVariableStatement(row)) for (const item of row.declarationList.declarations) {
      if (!ts.isIdentifier(item.name)) continue;
      locals.set(item.name.text,item.initializer);
      if (row.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) exports.set(item.name.text,item.name.text);
    }
    if (ts.isImportDeclaration(row) && ts.isStringLiteral(row.moduleSpecifier)) {
      const bindings = row.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        imports.set(item.name.text,[row.moduleSpecifier.text,(item.propertyName ?? item.name).text]);
      }
    }
    if (ts.isExportDeclaration(row) && row.exportClause && ts.isNamedExports(row.exportClause)) {
      for (const item of row.exportClause.elements) {
        const local = (item.propertyName ?? item.name).text;
        exports.set(item.name.text,row.moduleSpecifier && ts.isStringLiteral(row.moduleSpecifier) ? [row.moduleSpecifier.text,local] : local);
      }
    }
  }
  function bound(local: string, seen = new Set<string>()): boolean {
    if (seen.has(local)) return false;
    const origin = imports.get(local);
    if (origin) return imported(...origin);
    const value = locals.get(local);
    if (!value) return false;
    if (defines && local === name && ts.isStringLiteralLike(value)) return true;
    return ts.isIdentifier(value) && bound(value.text,new Set([...seen,local]));
  }
  return {
    exported: (symbol: string) => {
      const ref = exports.get(symbol);
      return typeof ref === "string" ? bound(ref) : ref ? imported(...ref) : false;
    },
    names: [...exports.keys()],
    key: (module: string, symbol: string) => imported(module,symbol),
    declaration: (item: ts.VariableDeclaration) => defines && ts.isIdentifier(item.name) && item.name.text === name
      && !!item.initializer && ts.isStringLiteralLike(item.initializer) && item.parent.parent.parent === tree,
  };
}
