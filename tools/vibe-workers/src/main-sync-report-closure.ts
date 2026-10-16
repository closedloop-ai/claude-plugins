import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { isLocalPlanPath } from "../../../plugins/vibe/skills/vibe/scripts/local-plans.mjs";
import { MainSyncError } from "./main-sync-contracts.js";
import { readInputModule, isInputModulePath, inputModuleReferences, referenceMatches, inputCallName, inputBuiltin,
  inputExpressionReference, inputKnownString, type NativeReferenceEnvironment } from "./main-sync-input-references.js";
import { reportOutputs } from "./main-sync-input-catalog.js";
import { reportChildEntries, reportLoaderEntries, reportRelativeCwd, reportShellEntries, reportLiteralWords,
  workspaceDirectory, type ReportCommandEntry, type ReportCwd } from "./main-sync-report-command.js";
import type { ReportExecution } from "./main-sync-report-execution.js";
import { rejectReportReplay } from "./main-sync-report-execution.js";
import { isolatedReportArgument } from "./main-sync-report-fixture.js";
import { committedSet, withCommittedTree } from "./main-sync-committed-tree.js";

const MODULE_EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", ".cts", ".mts", "/index.ts", "/index.js"];
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const PUBLIC_MODULE = /\.[cm]?[jt]sx?$/;
const SYMBOLIC_LOADER = /^--(?:import|require)(?:=|\s+)([\s\S]+)$/;
const packageSchema = z.object({ name: z.string(), dependencies: z.record(z.string()).optional(),
  devDependencies: z.record(z.string()).optional(), main: z.string().optional(), exports: z.unknown().optional() }).passthrough();

/** Only the actual selected entry closure is an execution claim; unrelated capable code stays capability evidence. */
export function verifyReportClosure(execution: ReportExecution, entries: readonly ReportCommandEntry[]) {
  withCommittedTree(execution.root, () => walkReportClosure(execution, entries));
}

function walkReportClosure(execution: ReportExecution, entries: readonly ReportCommandEntry[]) {
  const tracked = committedSet(execution.root);
  const pending = [...entries];
  const seen = new Set<string>();
  const contexts = new Set<string>();
  while (pending.length) {
    const entry = pending.shift()!;
    const identity = JSON.stringify(entry);
    if (seen.has(identity)) continue;
    // Committed membership bounds file coverage. Bound distinct native environments separately,
    // so one legitimate large source graph fits without collapsing different cwd/argv bindings.
    const contextIdentity = JSON.stringify([entry.context, entry.argv]);
    if (!contexts.has(contextIdentity) && contexts.size >= 4096) throw unproved("selected closure context bound");
    contexts.add(contextIdentity);
    seen.add(identity);
    if (!tracked.has(entry.file) || isLocalPlanPath(entry.file)) throw unproved("selected entry is not public committed source");
    if (entry.file.endsWith(".sh")) {
      pending.push(...reportShellEntries(execution, entry.file, entry.context));
      continue;
    }
    const source = readInputModule(execution.root, entry.file, nativeEnvironment(entry.context, entry.argv));
    const collected = new Set<string>();
    if (inputModuleReferences(execution.root, entry.file, (file, reference) => {
      if (reference.kind !== "path") {
        for (const candidate of tracked) {
          if (PUBLIC_MODULE.test(candidate) && !isLocalPlanPath(candidate)
            && referenceMatches(execution.root, file, reference, [candidate])) collected.add(candidate);
        }
      }
      return referenceMatches(execution.retainedRoot, file, reference, [...reportOutputs]);
    }, source)) {
      throw new MainSyncError(`Selected committed reader consumes retained report evidence: ${entry.file}; no output-only admission`, "NEEDS_CHANGE");
    }
    pending.push(...[...collected].map(file => ({ ...entry, file, argv: [] })));
    const inspect = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
        if (!ts.isStringLiteralLike(node.moduleSpecifier)) return;
        pending.push(...resolveImport(execution.root, entry.file, node.moduleSpecifier.text, tracked, "import")
          .map(file => ({ ...entry, file })));
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || inputCallName(node.expression) === "require") {
          const target = node.arguments[0];
          if (!target) return;
          const literal = ts.isStringLiteralLike(target);
          const specifier = literal ? target.text : inputKnownString(inputExpressionReference(execution.root, entry.file, target, "module"));
          if (specifier === undefined || !literal && !specifier.startsWith(".")) return;
          pending.push(...resolveImport(execution.root, entry.file, specifier, tracked,
            node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : "require")
            .map(file => ({ ...entry, file })));
        }
        const name = inputCallName(node.expression);
        if (["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"].includes(name)
          && inputBuiltin(node.expression, ["node:child_process", "child_process"])) {
          const program = node.arguments[0];
          const args = node.arguments[1];
          if (program && ts.isStringLiteralLike(program) && args && ts.isArrayLiteralExpression(args)) {
            const context = childContext(execution, entry, node.arguments[2]);
            pending.push(...context.loaders);
            const values = args.elements.map(argument => ts.isExpression(argument)
              ? inputExpressionReference(execution.root, entry.file, argument) : undefined);
            const isolated = args.elements.length === 2 && ts.isExpression(args.elements[1]!)
              ? isolatedReportArgument(execution.root, entry.file, node, args.elements[1]!) : undefined;
            const script = inputKnownString(values[0]);
            if (program.text === "node" && isolated && script && context.cwd.kind === "known") {
              const target = resolve(context.cwd.path, script);
              if (!target.startsWith(`${execution.root}/`)) throw unproved("isolated reader escapes owned root");
              const file = relative(execution.root, target);
              if (!tracked.has(file) || isLocalPlanPath(file)) throw unproved("isolated reader is not committed source");
              pending.push({ file, context: context.cwd, argv: [process.execPath, target, isolated] });
              ts.forEachChild(node, inspect);
              return;
            }
            rejectReportReplay(values.filter(value => value?.kind === "path").map(value => value!.kind === "path" ? value!.value : "").join(" "));
            const literals = values.map(inputKnownString);
            if (program.text === "node" && script) {
              const selected = reportChildEntries(execution, [program.text, script], context.cwd);
              const arguments_: NativeReferenceEnvironment["argv"][number][] = values.slice(1).map((reference) => {
                const literal = inputKnownString(reference);
                if (literal !== undefined) return literal;
                if (reference?.kind === "path") return { constraint: reference };
                return "";
              });
              pending.push(...selected.map(item => ({ ...item, argv: [process.execPath, join(execution.root, item.file), ...arguments_] })));
            } else if (literals.every(value => value !== undefined)) {
              pending.push(...reportChildEntries(execution, [program.text, ...literals], context.cwd));
            }
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
}

function resolveImport(root: string, importer: string, specifier: string, tracked: ReadonlySet<string>, mode: "import" | "require"): string[] {
  if (BUILTINS.has(specifier)) return [];
  if (specifier.startsWith(".")) {
    const path = resolve(dirname(join(root, importer)), specifier);
    if (!path.startsWith(`${root}/`)) throw unproved("selected import escapes owned root");
    const stem = relative(root, path);
    return trackedModule(stem, tracked);
  }
  if (specifier.startsWith("@repo/") || specifier.startsWith("@closedloop-ai/")) {
    return workspaceImport(root, specifier, tracked, mode);
  }
  // Installed package internals are not a general filesystem non-read obligation.
  return [];
}

function workspaceImport(root: string, specifier: string, tracked: ReadonlySet<string>, mode: "import" | "require") {
  const pieces = specifier.split("/");
  const name = pieces.slice(0, 2).join("/");
  const subpath = pieces.slice(2).join("/");
  const base = workspaceDirectory(root, name);
  if (!base) return [];
  const manifest = packageSchema.parse(JSON.parse(readFileSync(join(root, base, "package.json"), "utf8")));
  const targets = workspaceTargets(manifest.exports, manifest.main, subpath, mode);
  const selected: string[] = [];
  for (const target of targets) {
    if (target.includes("*")) {
      selected.push(...[...tracked].filter(file => file.startsWith(`${base}/`) && PUBLIC_MODULE.test(file)));
      continue;
    }
    const absolute = resolve(root, base, target);
    if (!absolute.startsWith(`${join(root, base)}/`)) throw unproved("workspace export escapes committed owner");
    selected.push(...trackedModule(relative(root, absolute), tracked));
  }
  return [...new Set(selected)];
}

function moduleCandidates(path: string) {
  const candidates = MODULE_EXTENSIONS.map(extension => path + extension);
  if (path.endsWith(".js")) candidates.push(path.slice(0, -3) + ".ts", path.slice(0, -3) + ".tsx");
  if (path.endsWith(".mjs")) candidates.push(path.slice(0, -4) + ".mts");
  return candidates;
}

/** Public data imports such as stylesheets stay unparsed; private planning paths still reach the entry refusal. */
function trackedModule(path: string, tracked: ReadonlySet<string>) {
  const candidate = moduleCandidates(path).find(file => tracked.has(file) && (isInputModulePath(file) || isLocalPlanPath(file)));
  return candidate ? [candidate] : [];
}

function unproved(reason: string) {
  return new MainSyncError(`Selected report execution provenance is unproved: ${reason}; no retained-input admission`, "NEEDS_CHANGE");
}

function workspaceTargets(exports: unknown, main: string | undefined, subpath: string, mode: "import" | "require"): string[] {
  if (exports === undefined) return [subpath || main || "index"];
  const key = subpath ? `./${subpath}` : ".";
  if (typeof exports === "string") return key === "." ? [exports] : [];
  if (Array.isArray(exports)) return key === "." ? conditionalTargets(exports, 0, mode) : [];
  const object = z.record(z.unknown()).safeParse(exports);
  if (!object.success) return [];
  const mapping = object.data;
  const subpaths = Object.keys(mapping).some(name => name.startsWith("."));
  if (subpaths && !Object.hasOwn(mapping, key) && Object.keys(mapping).some(name => name.includes("*"))) {
    return Object.values(mapping).flatMap(target => conditionalTargets(target, 0, mode));
  }
  const value = subpaths ? mapping[key] : key === "." ? mapping : undefined;
  return conditionalTargets(value, 0, mode);
}

function conditionalTargets(value: unknown, depth: number, mode: "import" | "require"): string[] {
  if (depth > 8) throw unproved("workspace condition bound");
  if (typeof value === "string") return [value];
  if (value === null || value === undefined) return [];
  const mapping = z.record(z.unknown()).safeParse(value);
  if (!mapping.success) {
    return Array.isArray(value) ? value.flatMap(target => conditionalTargets(target, depth + 1, mode)) : [];
  }
  const keys = Object.keys(mapping.data);
  if (keys.some(key => !["node", "import", "require", "default", "types"].includes(key))) {
    return Object.values(mapping.data).flatMap(target => conditionalTargets(target, depth + 1, mode));
  }
  for (const [key, target] of Object.entries(mapping.data)) {
    if (key === "node" || key === mode || key === "default") return conditionalTargets(target, depth + 1, mode);
  }
  return [];
}

/** Only applicable explicit child options select loaders; inherited environment is not inspected. */
function childContext(execution: ReportExecution, entry: ReportCommandEntry, options: ts.Expression | undefined) {
  let cwd = entry.context;
  const loaders: ReportCommandEntry[] = [];
  if (!options || !ts.isObjectLiteralExpression(options)) return { cwd, loaders };
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : "";
    if (key === "cwd") {
      const reference = inputExpressionReference(execution.root, entry.file, property.initializer);
      const value = inputKnownString(reference);
      if (value) cwd = reportRelativeCwd(execution.root, entry.context, value);
      else cwd = { kind: "possible", suffix: "", ...(reference?.kind === "path" ? { constraints: reference } : {}) };
    }
  }
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) || property.name.text !== "env"
      || !ts.isObjectLiteralExpression(property.initializer)) continue;
    for (const field of property.initializer.properties) {
      if (!ts.isPropertyAssignment(field) || !(ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name)) || field.name.text !== "NODE_OPTIONS") continue;
      const reference = inputExpressionReference(execution.root, entry.file, field.initializer);
      const value = inputKnownString(reference);
      const words = value === undefined ? undefined : reportLiteralWords(value);
      if (!words) {
        if (reference?.kind === "path") {
          const target = SYMBOLIC_LOADER.exec(reference.value)?.[1];
          if (target) {
            loaders.push(...reportLoaderEntries(execution, entry.file, { ...reference, value: target }, cwd));
          }
        }
        continue;
      }
      for (let index = 0; index < words.length; index++) {
        const word = words[index]!;
        const mode = word.startsWith("--import") ? "--import" : word.startsWith("--require") ? "--require" : undefined;
        if (!mode) continue;
        const target = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[++index];
        if (!target) throw unproved("explicit loader target missing");
        if (target === "tsx/esm" || target === "tsx") continue;
        loaders.push(...reportLoaderEntries(execution, entry.file, target, cwd));
      }
    }
  }
  return { cwd, loaders };
}

/** Possible contexts expose no certified runtime directory to native path evaluation. */
function nativeEnvironment(context: ReportCwd, argv: NativeReferenceEnvironment["argv"]): NativeReferenceEnvironment {
  return context.kind === "known" ? { cwd: context.path, argv } : { argv };
}
