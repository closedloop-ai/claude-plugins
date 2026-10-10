import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireNativeRecord, releaseNativeRecord } from "./native-record.js";
import { changeWriter, registerWriter } from "./ledger.js";
import { bundleDirectory, fixture, graph } from "./test-fixtures.js";
import type { RequestContinuation } from "./record-context.js";
import { z } from "zod";

const producerFixtureSchema = z.object({ purpose: z.string(), origin: z.object({ repository: z.literal("closedloop-ai/symphony-alpha"),
  commit: z.literal("3dd896dfcecd5b14940fbebe3a10f969bcb8c93e"), license: z.literal("Apache-2.0"), copyright: z.string() }).strict(),
  files: z.array(z.object({ path: z.enum(["lint-staged.config.js", "scripts/exec-git.ts", "LICENSE"]), gitBlob: z.string(), sha256: z.string(), content: z.string() }).strict()).length(3) }).strict();

export function syncFixture(source = "committed-good") {
  const value = fixture();
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c",
    "user.email=fixture@example.invalid", ...args], { cwd: value.worktree, encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
  const write = (file: string, text: string) => {
    const target = join(value.worktree, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, text);
  };
  git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  write(".gitignore", ".closedloop-ai/\n.control/\nnode_modules/\n");
  write("apps/app/probe.ts", `export const answer = '${source}';\n`);
  write("package.json", JSON.stringify({ scripts: { "test:affected": "fixture", "typecheck:affected": "fixture",
    "check:source-gates": "fixture", "test:lanes": "fixture", verify: "fixture", test: "fixture" } }));
  write("scripts/lint/affected-test-lanes.ts", String.raw`
export async function loadOutOfGraphLanes() {return [{script:'test:skills', roots:['scripts/']}];}
export function lanesCoveringPaths(paths, lanes) {return lanes.flatMap(lane => {const found=paths.filter(path => path.startsWith('scripts/')); return found.length ? [{lane,paths:found}] : [];});}
export function referencedLanes() {return [];}
`);
  write("scripts/lint/report-test-lanes.ts", "export function laneCiCommand(script) {return {script};}\nexport function execPlan(_, commands) {return commands;}\n");
  write("scripts/lint/desktop-e2e-lane.ts", "export function desktopE2eLane(paths) {return paths.includes('apps/desktop/test/reveal-window.spec.ts') ? {ci:{script:'test:e2e',dir:'apps/desktop'},paths} : undefined;}\n");
  write("scripts/lint/workflow-shell-harness.ts", "export function loadWorkflowOrThrow() {return {jobs:{'desktop-e2e':{steps:[{name:'Run Electron e2e','working-directory':'apps/desktop',run:'unsupported bare Electron fixture'}]}}};}\n");
  git(["add", "."]);
  git(["commit", "-m", "Committed validation fixture"]);
  git(["branch", "main"]);
  const origin = join(value.base, "origin.git");
  git(["init", "--bare", "--initial-branch=main", origin]);
  git(["remote", "add", "origin", origin]);
  git(["push", "origin", "main"]);
  const baseCommit = git(["rev-parse", "HEAD"]);
  const record = { worktree: value.worktree, branch: "vibe/test", slug: "test", status: "active", mode: "blank",
    baseCommit, createdAt: "2026-10-09T00:00:00Z", operator: { id: "fixture-owner", email: "owner@example.invalid", name: "Fixture" },
    localFixes: [] as { ticket: string; paths: string[] }[], vercel: { lastDeployedCommit: null },
    flagSnapshot: { takenAt: "2026-10-09T00:00:00Z", distinctId: "fixture", flagCount: 0,
      file: join(value.metadata, "vibe-flag-snapshot.json") } };
  const save = () => writeFileSync(join(value.metadata, "vibe-session.json"), JSON.stringify(record));
  save();
  writeFileSync(record.flagSnapshot.file, JSON.stringify({ takenAt: record.flagSnapshot.takenAt,
    distinctId: "fixture", flags: {} }));
  writeFileSync(join(value.bin, "pnpm"), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.cwd(), '.git', 'validation-calls.jsonl'), JSON.stringify(args) + '\n');
if (args[0] === 'exec' && args[1] === 'node') {
  const cp = require('node:child_process');
  const run = cp.spawnSync(process.execPath, args.slice(4), {cwd:process.cwd(), encoding:'utf8', input:fs.readFileSync(0,'utf8')});
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || ''); process.exit(run.status ?? 1);
}
if (args[0] === 'test:lanes' && args.includes('--exec') && fs.existsSync(path.join(process.cwd(), 'apps/desktop/test/reveal-window.spec.ts'))) {
  fs.writeFileSync(path.join(process.cwd(), '.git', 'unsafe-lane-spawned'), 'bare Electron lane invoked');
}
if (args.includes('--dry=json')) {
  process.stdout.write(JSON.stringify({ tasks: [{ taskId: 'app#' + (args[1] || args[0]), package: 'app' }] }));
  process.exit(0);
}
const command = args[0];
if (!['exec', 'check:source-gates', 'typecheck:affected', 'test:affected', 'test:lanes', 'turbo', 'verify', 'test', '--filter', 'vibe', 'test:lint', 'test:skills'].includes(command)) process.exit(2);
if (fs.readFileSync(path.join(process.cwd(), 'apps/app/probe.ts'), 'utf8').includes('committed-bad')) {
  process.stderr.write('committed behavior fails\n'); process.exit(1);
}
process.stdout.write(command === 'test:lanes' ? 'pnpm --filter app test\n' : 'actual fixture check passed\n');
`, { mode: 0o700 });
  let sequence = 0;
  const transaction = () => {
    const file = join(value.metadata, "vibe-main-sync.json");
    return existsSync(file) ? String(JSON.parse(readFileSync(file, "utf8")).transactionId) : undefined;
  };
  const start = (action: "create" | "redeploy" | "flags" | "desktop" | "share", purpose?: "build" | "handoff",
    agentRoot = value.agentRoot, options?: { requestId?: string; continuations?: RequestContinuation[] }) => {
    const number = ++sequence;
    const mainSyncTransactionId = transaction();
    const grant = { worktree: value.worktree, agentRoot, agentName: action === "share" ? "vibe-prototype-worker" : "vibe-environment-worker",
      mode: "record" as const, recordAction: action, exclusiveRecordTurn: true as const,
      workerId: `fixture-helper-${number}`, requestId: options?.requestId ?? `helper-request-${number}`,
      ...(purpose ? { publicationPurpose: purpose } : {}), ...(mainSyncTransactionId ? { mainSyncTransactionId } : {}),
      ...(options?.continuations ? { mainSyncRequestContinuations: options.continuations } : {}) };
    const acquired = acquireNativeRecord(grant);
    return { context: { runtime: "codex", worktree: value.worktree, agentName: grant.agentName,
      mode: grant.mode, recordAction: action, workerId: grant.workerId, requestId: grant.requestId,
      lease: acquired.lease, ...(purpose ? { publicationPurpose: purpose } : {}), ...(mainSyncTransactionId ? { mainSyncTransactionId } : {}),
      ...(options?.continuations ? { mainSyncRequestContinuations: options.continuations } : {}) },
      finish: () => releaseNativeRecord({ ...grant, lease: acquired.lease,
        stoppedTurn: { runtime: "codex", workerId: grant.workerId, requestId: grant.requestId,
          lease: acquired.lease, state: "completed" } }) };
  };
  let registered = false;
  const sourceTurn = (purpose?: "build" | "handoff", agentRoot = value.agentRoot,
    options?: { ciRun?: { runId: number; attempt: number } }) => {
    if (!registered) {
      registerWriter({ worktree: value.worktree, runtime: "codex", workerId: "fixture-source",
        agentRoot: value.agentRoot, agentName: "vibe-change-worker", capabilities: graph });
      registered = true;
    }
    const requestId = `validation-${++sequence}`;
    const mainSyncTransactionId = transaction();
    const source = { worktree: value.worktree, workerId: "fixture-source", requestId };
    changeWriter("enqueue", { ...source, input: "Validate exact committed fixture" });
    const claimed = changeWriter("claim", source);
    const lease = claimed.turn?.lease;
    if (!lease) throw new Error("Fixture source claim has no lease");
    const grant = { ...source, agentRoot, agentName: "vibe-change-worker", mode: "record" as const,
      recordAction: "progress" as const, exclusiveRecordTurn: true as const,
      primaryOwner: { workerId: source.workerId, lease }, ...(purpose ? { publicationPurpose: purpose } : {}),
      ...(mainSyncTransactionId ? { mainSyncTransactionId } : {}),
      ...(options?.ciRun ? { mainSyncCiRun: options.ciRun } : {}) };
    const acquired = acquireNativeRecord(grant);
    return { context: { runtime: "codex", worktree: value.worktree, agentName: grant.agentName, mode: grant.mode,
      recordAction: grant.recordAction, workerId: source.workerId, requestId, lease: acquired.lease,
      ...(purpose ? { publicationPurpose: purpose } : {}), ...(mainSyncTransactionId ? { mainSyncTransactionId } : {}),
      ...(options?.ciRun ? { mainSyncCiRun: options.ciRun } : {}) }, finish: () => {
        releaseNativeRecord({ ...grant, lease: acquired.lease,
          stoppedTurn: { runtime: "codex", workerId: source.workerId, requestId, lease: acquired.lease, state: "completed" } });
        changeWriter("finish", { ...source, lease, status: "DONE",
          stoppedTurn: { runtime: "codex", workerId: source.workerId, requestId, lease, state: "completed" } });
      } };
  };
  return { ...value, git, write, origin, baseCommit, record, save, start, sourceTurn,
    calls: () => readFileSync(join(value.metadata, "validation-calls.jsonl"), "utf8") };
}

/** Runs a complete prepared/check/push fixture using the same registered source identity throughout. */
export function validateFixture(value: ReturnType<typeof syncFixture>, purpose?: "build" | "handoff") {
  const prepare = value.start("redeploy", purpose);
  try {
    const result = invokeSync(value, "prepare", prepare.context);
    if (result.status !== 0) throw new Error(result.stdout || result.stderr);
  } finally { prepare.finish(); }
  const source = value.sourceTurn(purpose);
  try {
    const result = invokeSync(value, "validate", source.context);
    if (result.status !== 0) throw new Error(result.stdout || result.stderr);
    return result;
  } finally { source.finish(); }
}

export function invokeSync(value: ReturnType<typeof syncFixture>, command: string, context: unknown,
  extra: Record<string, unknown> = {}) {
  const script = command === "prepare" ? join(bundleDirectory, "../commit-worktree.mjs")
    : join(bundleDirectory, "../vibe-sessions.mjs");
  const args = command === "prepare" ? ["--prepare-main-sync", "--worktree", value.worktree]
    : command === "request" ? ["dispatch-inputs", "--worktree", value.worktree, "--out", join(value.metadata, "request.json")]
    : [`main-sync-${command}`, "--worktree", value.worktree];
  const result = spawnSync(process.execPath, [script, ...args], { input: JSON.stringify({ context, ...extra }),
    cwd: value.worktree, encoding: "utf8", timeout: 20000,
    env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` } });
  if (result.error) throw result.error;
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : undefined };
}

/** Seeds only temporary synthetic Git with opaque reviewed Source test data and invokes its real pure export. */
export function generatedBiomeFixture(value: ReturnType<typeof syncFixture>) {
  const data = producerFixtureSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/symphony-biome-noscan-producer.json", import.meta.url), "utf8")));
  for (const file of data.files) {
    const bytes = Buffer.from(file.content);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.gitBlob) {
      throw new Error("Opaque Source producer fixture identity changed");
    }
    value.write(file.path, file.content);
  }
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n/.biome-noscan.jsonc*\n`);
  const config = '{\n  "linter": {\n    "domains": {\n      "project": "all",\n      "types": "all"\n    },\n    "rules": {"first": "error", "second": "warn"}\n  }\n}\n\n';
  value.write("biome.jsonc", config);
  value.git(["add", "."]); value.git(["commit", "-m", "Canonical Source producer test data"]);
  const derive = () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
      "import {readFileSync} from 'node:fs'; import {noScanBiomeConfig} from './lint-staged.config.js'; process.stdout.write(noScanBiomeConfig(readFileSync('biome.jsonc','utf8')));"],
      { cwd: value.worktree, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.stderr || "Actual Source fixture pure transform failed");
    return result.stdout;
  };
  const artifact = join(value.worktree, ".biome-noscan.jsonc");
  const output = derive();
  writeFileSync(artifact, output);
  return { artifact, config, output, derive };
}
