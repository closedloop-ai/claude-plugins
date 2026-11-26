import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const owners = ["plugins/vibe", "tools/vibe-workers/src", "tools/vibe-closedloop-build/src"];
// Generated and vendored third-party code is not owned source; a minified bundle (cl-work-report's mermaid asset) was
// most of this scan's time and holds none of the reader patterns this repository owns.
const generated = /\/dist\/|\/node_modules\/|\/vendor\/|\.min\.js$|^(?:.*\/)?(?:agent-frontmatter|workflow-lane-definitions)\.mjs$/;
const tests = /(?:^|\/)(?:tests?|fixtures?)\/|(?:\.test|-fixture|-test-support)[.s-]/;

/** Check field comparisons and stdout provenance inside each lexical function. */
function violations(file: string, content: string) {
  if (!/JSON\s*\.\s*parse|(?:name|description)\s*:/.test(content)) return [];
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  const importedExecutions = new Set(["execSync", "execFileSync"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const imported = statement.moduleSpecifier.text;
    if (!/^(?:node:)?child_process$/.test(imported) && !imported.endsWith("/owned-state.mjs")) continue;
    const imports = statement.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    for (const item of imports.elements) {
      const name = (item.propertyName ?? item.name).text;
      if (imported.endsWith("/owned-state.mjs") ? name === "dockerResult" : importedExecutions.has(name)) importedExecutions.add(item.name.text);
    }
  }
  // Successful stdout adapters retain provenance through local aliases and return statements.
  function stdoutAdapter(node: ts.FunctionLikeDeclaration): boolean {
    const aliases = new Set<string>();
    function returnsBytes(part: ts.Node): boolean {
      if (ts.isIdentifier(part)) return aliases.has(part.text);
      if (ts.isPropertyAccessExpression(part) && part.name.text === "stdout") return true;
      if (ts.isCallExpression(part) && ts.isIdentifier(part.expression) && importedExecutions.has(part.expression.text)) return true;
      if (ts.isCallExpression(part) && (part.expression.getText(source) === "JSON.parse" || part.expression.getText(source) === "capturedJson")) return false;
      return ts.forEachChild(part, child => returnsBytes(child) || undefined) === true;
    }
    function visit(part: ts.Node): boolean {
      if (ts.isFunctionLike(part)) return false;
      if (ts.isVariableDeclaration(part) && ts.isIdentifier(part.name) && part.initializer && returnsBytes(part.initializer)) aliases.add(part.name.text);
      if (ts.isReturnStatement(part)) return !!part.expression && returnsBytes(part.expression);
      return ts.forEachChild(part, child => visit(child) || undefined) === true;
    }
    return !!node.body && (ts.isBlock(node.body) ? visit(node.body) : returnsBytes(node.body));
  }
  for (const row of source.statements) {
    if (ts.isFunctionDeclaration(row) && row.name && stdoutAdapter(row)) importedExecutions.add(row.name.text);
    if (ts.isVariableStatement(row)) for (const item of row.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.initializer && (ts.isArrowFunction(item.initializer) || ts.isFunctionExpression(item.initializer))
          && stdoutAdapter(item.initializer)) importedExecutions.add(item.name.text);
    }
  }
  function inspect(scope: ts.Node, inherited: Map<string, ts.Expression>) {
    const bindings = new Map(inherited);
    const executionNames = new Set(importedExecutions);
    function fieldLiteral(node: ts.Expression, seen = new Set<string>()): boolean {
      if (ts.isStringLiteralLike(node)) return /\b(?:name|description)\s*:/.test(node.text);
      if (!ts.isIdentifier(node) || seen.has(node.text)) return false;
      const value = bindings.get(node.text);
      return !!value && fieldLiteral(value, new Set([...seen, node.text]));
    }
    function execution(node: ts.Expression, seen = new Set<string>()): boolean {
      if (ts.isPropertyAccessExpression(node)) return /^(execFileSync|execSync)$/.test(node.name.text);
      if (!ts.isIdentifier(node) || seen.has(node.text)) return false;
      const bound = bindings.get(node.text);
      return bound ? execution(bound, new Set([...seen, node.text])) : executionNames.has(node.text);
    }
    function captured(node: ts.Node, seen = new Set<string>()): boolean {
      if (ts.isIdentifier(node)) {
        if (seen.has(node.text)) return false;
        const bound = bindings.get(node.text);
        return !!bound && captured(bound, new Set([...seen, node.text]));
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "stdout") return true;
      if (ts.isPropertyAccessExpression(node) && node.name.text === "text" && ts.isElementAccessExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "content") return true;
      if (ts.isCallExpression(node) && node.expression.getText(source) === "readFileSync") return false;
      if (ts.isCallExpression(node) && execution(node.expression)) return true;
      return ts.forEachChild(node, child => captured(child, seen) || undefined) === true;
    }
    function visit(node: ts.Node) {
      if (node !== scope && ts.isFunctionLike(node)) { inspect(node, bindings); return; }
      // Inspect executable JavaScript emitted inside a template as its own source.
      if (ts.isTemplateExpression(node) && /require\(['"]node:child_process['"]\)/.test(node.head.text)) {
        const script = node.head.text + node.templateSpans.map(span => "null" + span.literal.text).join("");
        findings.push(...violations(file + "#embedded", script));
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name)) bindings.set(node.name.text, node.initializer);
        else if (ts.isObjectBindingPattern(node.name)) for (const field of node.name.elements) {
          const key = (field.propertyName ?? field.name).getText(source);
          if (executionNames.has(key)) executionNames.add(field.name.getText(source));
          if (key === "stdout") {
            bindings.set(field.name.getText(source), ts.factory.createPropertyAccessExpression(node.initializer, "stdout"));
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        bindings.set(node.left.text, node.right);
      }
      const mark = (why: string) => findings.push(file + ":" + (1 + source.getLineAndCharacterOfPosition(node.getStart(source)).line) + " " + why);
      if (ts.isCallExpression(node) && node.expression.getText(source) === "JSON.parse" && node.arguments[0] && captured(node.arguments[0])) mark("captured stdout");
      if (ts.isIdentifier(node) && ((ts.isCallExpression(node.parent) && node.parent.arguments.some(arg => arg === node)
        && /\.(?:startsWith|includes|indexOf|split)$/.test(node.parent.expression.getText(source))) ||
        (ts.isBinaryExpression(node.parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.parent.operatorToken.kind))) && fieldLiteral(node)) mark("frontmatter field comparison");
      if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateExpression(node)) {
        const text = node.getText(source);
        if (/\b(?:name|description)\s*:/.test(text) && (ts.isRegularExpressionLiteral(node) ||
          (ts.isCallExpression(node.parent) && /\.(?:startsWith|includes|indexOf|split)$/.test(node.parent.expression.getText(source))) ||
          (ts.isBinaryExpression(node.parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.parent.operatorToken.kind)))) mark("frontmatter field comparison");
      }
      ts.forEachChild(node, visit);
    }
    visit(scope);
  }
  inspect(source, new Map());
  return findings;
}

/** Embedded Node snippets reading a piped tool result share the same single-document adapter. */
function shellCaptures(text: string) {
  const nodes = text.matchAll(/\|\s*node\s+(?:--input-type=module\s+)?-e\s+'([^']*)'/gs);
  return [...nodes].filter(([, script = ""]) => /JSON\s*\.\s*parse\s*\(/.test(script) && /process\.stdin/.test(script));
}

it("AC-082 and AC-083 reject literal frontmatter reads and captured stdout parses in production sources", () => {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...owners], { cwd: root, encoding: "utf8" }).split("\0");
  const findings = paths.filter(file => /\.(?:ts|[cm]?js)$/.test(file) && !tests.test(file) && !generated.test(file)
    && !file.endsWith(".d.mts") && !file.endsWith("/agent-frontmatter.ts")).flatMap(file => violations(file, readFileSync(root + "/" + file, "utf8")));
  expect(findings).toEqual([]);
  for (const file of paths.filter(file => file.endsWith(".sh") && !tests.test(file))) {
    expect(shellCaptures(readFileSync(root + "/" + file, "utf8")), file).toEqual([]);
  }
});

it("AC-082 and AC-083 distinguish field comparisons and aliased stdout from local documents", () => {
  expect(violations("sample.ts", "if (line === 'name: example') return true;")).toHaveLength(1);
  expect(violations("sample.ts", "if (/^description:/.test(line)) return true;")).toHaveLength(1);
  expect(violations("sample.ts", "const { stdout: output } = run(); const reply = output.trim(); JSON.parse(reply);")).toHaveLength(1);
  expect(violations("sample.ts", "import { execFileSync as run } from 'node:child_process'; JSON.parse(run('git'));")).toHaveLength(1);
  expect(violations("sample.ts", "const reply = await client.callTool(req); JSON.parse(reply.content[0].text);")).toHaveLength(1);
  expect(violations("sample.ts", "const key = 'name: '; line.startsWith(key);")).toHaveLength(1);
  expect(violations("sample.ts", "function output() { const r = run(); return String(r.stdout).trim(); } const bytes = output(); JSON.parse(bytes);")).toHaveLength(1);
  expect(violations("sample.ts", "import { dockerResult as output } from './owned-state.mjs'; JSON.parse(output(['inspect']));")).toHaveLength(1);
  expect(violations("sample.ts", "function output() { return readFileSync(file); } JSON.parse(output());")).toEqual([]);
  expect(shellCaptures("printf x | node -e 'process.stdin.on(data, x => JSON.parse(x));'")).toHaveLength(1);
  expect(violations("sample.ts", "const run = execFileSync; JSON.parse(run('fixture'));")).toHaveLength(1);
  expect(violations("sample.ts", "const data = readFileSync(file); JSON.parse(data);")).toEqual([]);
});
