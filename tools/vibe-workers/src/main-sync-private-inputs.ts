import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import picomatch from "picomatch";
import { isLocalPlanPath } from "../../../plugins/vibe/skills/vibe/scripts/local-plans.mjs";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { MainSyncError } from "./main-sync-contracts.js";
import { MAX_INPUT_BYTES } from "./main-sync-generated-input.js";

const MODULE_PATH = /\.(?:[cm]?[jt]sx?|json)$/;
const CONFIG_PATH = /(?:^|\/)(?:tsconfig[^/]*\.json|(?:vitest|playwright|storybook|next|source)\.config\.[cm]?[jt]s|\.storybook\/main\.[cm]?[jt]s)$/;
const COLLECTOR_KEYS = new Set(["include", "files", "testDir", "testMatch", "stories"]);
const READERS = new Set(["readFile", "readFileSync", "createReadStream", "glob", "globSync", "fastGlob"]);
const GLOB = /[*?]/;
let analyzed: { root: string; head: string; candidates: string; privatePaths: boolean } | undefined;

/** Checks owned archive paths and finite static import/collector references, not arbitrary runtime reachability. */
export function verifyPrivateInput(root: string, file: string, head: string) {
  verifyEvidencePath(root, file);
  const privatePaths = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter(isLocalPlanPath);
  const candidates = privatePaths.join("\0");
  if (analyzed?.root !== root || analyzed.head !== head || analyzed.candidates !== candidates) {
    analyzed = { root, head, candidates, privatePaths: referencesPrivateInputs(root, privatePaths) };
  }
  if (analyzed.privatePaths) {
    throw new MainSyncError("Private planning evidence is consumed by a committed import, reader or collector; preserve it and correct the same-writer input boundary", "NEEDS_CHANGE");
  }
}

/** Git can omit a symlinked private directory's descendants, so inspect the namespace itself first. */
export function verifyPrivateRoot(root: string) {
  for (const path of [".closedloop-ai", ".closedloop-ai/vibe-plans"]) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(join(root, path)) !== join(root, path))) {
      throw new MainSyncError("Private planning evidence requires its canonical owned directory; no symlink or alias is accepted", "NEEDS_CHANGE");
    }
  }
}

/** Checks only owned evidence metadata; neither private diagnostics nor report/auth bodies are opened. */
export function verifyEvidencePath(root: string, file: string, label = "Private planning evidence") {
  const target = join(root, file);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES || realpathSync(target) !== target) {
    throw new MainSyncError(`${label} requires a bounded canonical regular file`, "NEEDS_CHANGE");
  }
  for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
    if (!parent.startsWith(`${root}${sep}`) || lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) {
      throw new MainSyncError(`${label} cannot use a symlinked or escaping parent`, "NEEDS_CHANGE");
    }
  }
}

function referencesPrivateInputs(root: string, privatePaths: string[]) {
  return committedInputReferences(root, (file, value, collector, excludes) => {
    const target = relative(root, resolve(dirname(join(root, file)), value));
    const path = resolve(root, target);
    return isLocalPlanPath(target) || (existsSync(path) && isLocalPlanPath(relative(root, realpathSync(path))))
      || value.includes(".closedloop-ai/vibe-plans") || value === ".closedloop-ai" || value.startsWith(".closedloop-ai/")
      || Boolean(collector && GLOB.test(value) && collectsPrivate(root, file, value, privatePaths, excludes));
  });
}

/** Finite literal imports/readers/collector inputs share one syntax owner; no archived body is opened. */
export function committedInputReferences(root: string, matches: (file: string, value: string, collector?: boolean, excludes?: string[]) => boolean) {
  const files = git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean);
  return files.some((file) => {
    if (!MODULE_PATH.test(file) || isLocalPlanPath(file)) return false;
    const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    let found = false;
    const inspect = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        found ||= inputReference(file, node.moduleSpecifier, matches);
      } else if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === "require" || READERS.has(name)) {
          for (const argument of node.arguments) found ||= inputReference(file, argument, matches, name === "glob" || name === "globSync" || name === "fastGlob");
        }
      } else if (CONFIG_PATH.test(file) && ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
        if (COLLECTOR_KEYS.has(name)) found ||= inputReference(file, node.initializer, matches, true, collectorExcludes(node.parent));
      }
      if (!found) ts.forEachChild(node, inspect);
    };
    inspect(source);
    return found;
  });
}

function inputReference(file: string, expression: ts.Node, matches: (file: string, value: string, collector?: boolean, excludes?: string[]) => boolean,
  collector = false, excludes: string[] = []) {
  let found = false;
  const inspect = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      found ||= matches(file, node.text, collector, excludes);
    }
    if (!found) ts.forEachChild(node, inspect);
  };
  inspect(expression);
  return found;
}

function collectsPrivate(root: string, file: string, pattern: string, privatePaths: string[], excludes: string[] = []) {
  let base = dirname(join(root, file));
  while (base !== root && !existsSync(join(base, "package.json"))) base = dirname(base);
  const match = picomatch(pattern, { dot: true, ignore: excludes });
  return privatePaths.some((path) => match(relative(base, join(root, path))));
}

function collectorExcludes(node: ts.Node) {
  if (!ts.isObjectLiteralExpression(node)) return [];
  const values: string[] = [];
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      || property.name.text !== "exclude" || !ts.isArrayLiteralExpression(property.initializer)) continue;
    for (const value of property.initializer.elements) if (ts.isStringLiteralLike(value)) values.push(value.text);
  }
  return values;
}
