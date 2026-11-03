import { isAbsolute } from "node:path";
import ts from "typescript";
import { inputBuiltin, inputCallName, inputDeclaration, inputExpressionReference, inputKnownString,
  type IsolatedTestArgument } from "./main-sync-input-references.js";

/** Recognizes only a same-function native allocation/write/spawn/finally shape, never a helper name. */
export function isolatedReportArgument(root: string, file: string, call: ts.CallExpression, argument: ts.Expression): IsolatedTestArgument | undefined {
  if (!ts.isIdentifier(argument)) return undefined;
  const target = inputDeclaration(argument);
  if (!constant(target) || !target.initializer || !nativeCall(target.initializer, "join", "path") || target.initializer.arguments.length !== 2) return undefined;
  const directory = target.initializer.arguments[0];
  if (!directory || !ts.isIdentifier(directory)) return undefined;
  const allocation = inputDeclaration(directory);
  if (!constant(allocation) || !allocation.initializer || !nativeCall(allocation.initializer, "mkdtempSync", "fs")
    || allocation.initializer.arguments.length !== 1) return undefined;
  const prefix = allocation.initializer.arguments[0];
  if (!prefix || !nativeCall(prefix, "join", "path") || prefix.arguments.length !== 2) return undefined;
  const base = prefix.arguments[0];
  if (!base || !nativeCall(base, "tmpdir", "os") || base.arguments.length || !ts.isStringLiteralLike(prefix.arguments[1]!)) return undefined;
  const child = childName(root, file, target.initializer.arguments[1]!);
  if (!child) return undefined;
  let scope: ts.Node | undefined = call.parent;
  while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
  if (!scope || !ts.isFunctionDeclaration(scope) || !scope.body || scope.body.statements.length > 6) return undefined;
  const statements = [...scope.body.statements];
  if (!declares(statements.shift(), allocation) || !declares(statements.shift(), target)) return undefined;
  const final = statements.pop();
  if (!final || !ts.isTryStatement(final) || final.catchClause || !final.finallyBlock || final.tryBlock.statements.length !== 1) return undefined;
  const returned = final.tryBlock.statements[0];
  if (!returned || !ts.isReturnStatement(returned) || returned.expression !== call) return undefined;
  if (!statements.every(statement => optionalWrite(root, file, statement, scope, allocation, target))) return undefined;
  if (final.finallyBlock.statements.length !== 1) return undefined;
  const cleanup = expressionCall(final.finallyBlock.statements[0]);
  if (!cleanup || !nativeCall(cleanup, "rmSync", "fs") || cleanup.arguments.length !== 2 || !sameIdentifier(cleanup.arguments[0], allocation)) return undefined;
  return { isolatedTest: true, identity: `${file}:${allocation.pos}`, child };
}

function constant(node: ts.Node | undefined): node is ts.VariableDeclaration {
  return Boolean(node && ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const);
}

function declares(statement: ts.Statement | undefined, declaration: ts.VariableDeclaration) {
  return Boolean(statement && ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    && statement.declarationList.declarations[0] === declaration);
}

function nativeCall(node: ts.Node, name: string, module: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && inputCallName(node.expression) === name && inputBuiltin(node.expression, [`node:${module}`, module]);
}

function sameIdentifier(expression: ts.Expression | undefined, declaration: ts.VariableDeclaration) {
  return Boolean(expression && ts.isIdentifier(expression) && inputDeclaration(expression) === declaration);
}

function childName(root: string, file: string, expression: ts.Expression) {
  const value = inputKnownString(inputExpressionReference(root, file, expression));
  return value && value !== "." && value !== ".." && !isAbsolute(value) && !value.includes("/") && !value.includes("\\") ? value : undefined;
}

function expressionCall(statement: ts.Statement | undefined) {
  return statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : undefined;
}

function optionalWrite(root: string, file: string, statement: ts.Statement, scope: ts.FunctionDeclaration,
  directory: ts.VariableDeclaration, target: ts.VariableDeclaration) {
  if (!ts.isIfStatement(statement) || statement.elseStatement || !ts.isBlock(statement.thenStatement) || statement.thenStatement.statements.length !== 1) return false;
  const condition = ts.isBinaryExpression(statement.expression) ? statement.expression.left : statement.expression;
  if (!ts.isIdentifier(condition) || !scope.parameters.some(parameter => parameter === inputDeclaration(condition))) return false;
  if (ts.isBinaryExpression(statement.expression) && (statement.expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    || statement.expression.right.kind !== ts.SyntaxKind.NullKeyword)) return false;
  const write = expressionCall(statement.thenStatement.statements[0]);
  if (!write || !nativeCall(write, "writeFileSync", "fs") || write.arguments.length !== 2) return false;
  const destination = write.arguments[0];
  if (sameIdentifier(destination, target)) return true;
  return Boolean(destination && nativeCall(destination, "join", "path") && destination.arguments.length === 2
    && sameIdentifier(destination.arguments[0], directory) && childName(root, file, destination.arguments[1]!));
}
