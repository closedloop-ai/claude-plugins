import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { generatedBiomeFixture, invokeSync, syncFixture, validateFixture, currentSyncDefinitions } from "./main-sync-test-fixtures.js";
import { bundleDirectory, graph, recordWrite, writeAgent } from "./test-fixtures.js";
import { GENERATED_BIOME_PATH, MAX_INPUT_BYTES } from "./main-sync-generated-input.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
function setup(source?: string) { const value = syncFixture(source); fixtures.push(value); return value; }

describe("production main-sync publication CLIs", () => {
  it("admits only the real canonical committed-input Biome derivative without trimming raw trailing bytes or rewriting it", () => {
    const value = setup();
    const generated = generatedBiomeFixture(value);
    expect(generated.output.endsWith("\n\n")).toBe(true);
    expect(generated.output).toContain('"project": "none"');
    expect(generated.output).toContain('"types": "none"');
    const result = validateFixture(value);
    expect(result.status, result.stdout).toBe(0);
    const publisher = value.start("redeploy");
    try {
      const pushed = invokeSync(value, "push", publisher.context);
      expect(pushed.status, pushed.stdout).toBe(0);
      const request = invokeSync(value, "request", publisher.context);
      expect(request.status, request.stdout).toBe(0);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(value.git(["rev-parse", "HEAD"]));
      expect(readFileSync(generated.artifact, "utf8")).toBe(generated.output);
      expect(readFileSync(join(value.worktree, "biome.jsonc"), "utf8")).toBe(generated.config);
      expect(value.calls()).toContain('"check:source-gates"');
      expect(existsSync(join(value.metadata, "request.json"))).toBe(true);
    } finally { publisher.finish(); }
  }, 30000);
  it.each(["edited", "trimmed", "stale", "dirty-config", "staged-config", "dirty-owner", "committed-owner", "committed-import",
    "missing-owner", "symlink", "dangling-symlink", "directory", "oversized", "unignored", "nested", "suffix", "temporary", "mixed-source", "pure-throw"] as const)(
    "rejects %s generated-input counterfactual before capture/check/receipt/publication and preserves files", (failure) => {
    const value = setup(); const generated = generatedBiomeFixture(value);
    let inspected = generated.artifact;
    let expectedError = /generated.*differs|committed validation inputs/i;
    if (failure === "edited") writeFileSync(generated.artifact, `${generated.output}// altered\n`);
    if (failure === "trimmed") writeFileSync(generated.artifact, generated.output.trimEnd());
    if (failure === "stale" || failure === "dirty-config" || failure === "staged-config") {
      value.write("biome.jsonc", generated.config.replace('"first": "error"', '"first": "warn"'));
      if (failure !== "dirty-config") value.git(["add", "biome.jsonc"]);
      if (failure === "stale") value.git(["commit", "-m", "New committed config with stale derivative"]);
    }
    if (failure === "dirty-owner" || failure === "committed-owner") {
      value.write("lint-staged.config.js", `${readFileSync(join(value.worktree, "lint-staged.config.js"), "utf8")}\nwriteFileSync('.git/producer-executed', 'unsafe module');\n`);
      if (failure === "committed-owner") {
        value.git(["add", "lint-staged.config.js"]); value.git(["commit", "-m", "Deceptive committed producer"]);
        expectedError = /producer.*not.*reviewed/i;
      }
    }
    if (failure === "committed-import") {
      value.write("scripts/exec-git.ts", `${readFileSync(join(value.worktree, "scripts/exec-git.ts"), "utf8")}\nimport {writeFileSync} from 'node:fs'; writeFileSync('.git/producer-executed', 'unsafe import');\n`);
      value.git(["add", "scripts/exec-git.ts"]); value.git(["commit", "-m", "Deceptive committed import"]);
      expectedError = /producer.*not.*reviewed/i;
    }
    if (failure === "missing-owner") {
      rmSync(join(value.worktree, "lint-staged.config.js")); value.git(["add", "lint-staged.config.js"]);
      value.git(["commit", "-m", "Missing committed producer"]);
      expectedError = /could not verify.*canonical generated/i;
    }
    if (failure === "pure-throw") {
      value.write("biome.jsonc", '{"linter":{"rules":{"first":"error"}}}\n');
      value.git(["add", "biome.jsonc"]); value.git(["commit", "-m", "Config outside actual pure transform contract"]);
      expectedError = /read-only canonical generated-input probe failed/i;
    }
    if (failure === "symlink") {
      const target = join(value.metadata, "preserved-derived.jsonc"); writeFileSync(target, generated.output);
      rmSync(generated.artifact); symlinkSync(target, generated.artifact);
      expectedError = /bounded canonical regular file/i;
    }
    if (failure === "dangling-symlink") {
      rmSync(generated.artifact); symlinkSync(join(value.metadata, "absent-derived.jsonc"), generated.artifact);
      expectedError = /bounded canonical regular file/i;
    }
    if (failure === "oversized") { truncateSync(generated.artifact, MAX_INPUT_BYTES + 1); expectedError = /bounded canonical regular file/i; }
    if (failure === "directory") { rmSync(generated.artifact); mkdirSync(generated.artifact); expectedError = /bounded canonical regular file/i; }
    if (failure === "unignored") {
      value.write(".gitignore", readFileSync(join(value.worktree, ".gitignore"), "utf8").replace("/.biome-noscan.jsonc*\n", ""));
      value.git(["add", ".gitignore"]); value.git(["commit", "-m", "No ignored derivative contract"]);
    }
    if (failure === "nested" || failure === "suffix" || failure === "temporary") {
      rmSync(generated.artifact);
      const path = failure === "nested" ? "apps/app/.biome-noscan.jsonc" : failure === "suffix" ? ".biome-noscan.jsonc.extra.jsonc" : ".biome-noscan.jsonc.12345";
      value.write(path, generated.output); inspected = join(value.worktree, path);
      expectedError = /uncommitted executable|unsupported generated.*path/i;
    }
    if (failure === "mixed-source") {
      value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\nignored-probe.ts\n`);
      value.git(["add", ".gitignore"]); value.git(["commit", "-m", "Ignored authored input control"]);
      value.write("ignored-probe.ts", "export const unrelated = 'must still block';\n");
      expectedError = /uncommitted executable ignored-probe.ts/i;
    }
    const contents = failure === "oversized" || failure === "directory" || failure === "dangling-symlink" ? undefined : readFileSync(inspected);
    const stat = lstatSync(inspected);
    const session = readFileSync(join(value.metadata, "vibe-session.json"), "utf8");
    const head = value.git(["rev-parse", "HEAD"]); const turn = value.start("redeploy");
    try {
      const denied = invokeSync(value, "prepare", turn.context);
      expect(denied.status, denied.stdout).toBe(1);
      expect(denied.json?.status).toBe("NEEDS_CHANGE");
      expect(String(denied.json?.error)).toMatch(expectedError);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(existsSync(join(value.metadata, "MERGE_HEAD"))).toBe(false);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
      expect(existsSync(join(value.metadata, "producer-executed"))).toBe(false);
      if (existsSync(join(value.metadata, "validation-calls.jsonl"))) {
        expect(value.calls().split("\n").filter(Boolean).map((line) => JSON.parse(line))).not.toContainEqual(["check:source-gates"]);
      }
      expect(value.git(["rev-parse", "HEAD"])).toBe(head);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
      expect(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).toBe(session);
      expect(lstatSync(inspected).size).toBe(stat.size);
      expect(lstatSync(inspected).isSymbolicLink()).toBe(stat.isSymbolicLink());
      if (contents) expect(readFileSync(inspected)).toEqual(contents);
    } finally { turn.finish(); }
  }, 30000);
  it.each(["malformed", "conflicting-exit", "timeout", "changed-source"] as const)(
    "rejects %s pure-loader evidence before any transaction and does not expose dependency output", (failure) => {
    const value = setup(); const generated = generatedBiomeFixture(value);
    const pnpm = join(value.bin, "pnpm"); const original = readFileSync(pnpm, "utf8");
    if (failure === "changed-source") {
      writeFileSync(pnpm, original.replace("process.stdout.write(run.stdout || '');",
        "fs.writeFileSync(path.join(process.cwd(),'apps/app/probe.ts'),'source changed after pure probe'); process.stdout.write(run.stdout || '');"));
    } else {
      const exit = failure === "malformed" ? "process.stdout.write('not-json'); process.exit(0);" : failure === "timeout"
        ? "setInterval(() => {}, 1000); return;"
        : "process.stdout.write(JSON.stringify({path:path.join(process.cwd(),'.biome-noscan.jsonc'),bytes:fs.statSync(path.join(process.cwd(),'.biome-noscan.jsonc')).size,sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(process.cwd(),'.biome-noscan.jsonc'))).digest('hex')})); process.exit(1);";
      writeFileSync(pnpm, original.replace("if (args[0] === 'exec' && args[1] === 'node') {",
        `if (args[0] === 'exec' && args[1] === 'node') { process.stderr.write('RAW_LOADER_SECRET'); ${exit}`));
    }
    const turn = value.start("redeploy");
    try {
      const denied = invokeSync(value, "prepare", turn.context);
      expect(denied.status, denied.stdout).toBe(1);
      expect(denied.json?.status).toBe("NEEDS_CHANGE");
      expect(String(denied.json?.error)).toMatch(failure === "changed-source" ? /committed validation inputs differ.*probe.ts/i : /canonical generated/i);
      expect(`${denied.stdout}${denied.stderr}`).not.toContain("RAW_LOADER_SECRET");
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
      expect(readFileSync(generated.artifact, "utf8")).toBe(generated.output);
      if (failure === "changed-source") expect(readFileSync(join(value.worktree, "apps/app/probe.ts"), "utf8")).toBe("source changed after pure probe");
    } finally { turn.finish(); }
  }, 30000);
  it("rejects a changed derivative during a successful source check without issuing a validation receipt", () => {
    const value = setup(); const generated = generatedBiomeFixture(value);
    const prepare = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const pnpm = join(value.bin, "pnpm");
    writeFileSync(pnpm, readFileSync(pnpm, "utf8").replace("const command = args[0];",
      "if (args[0] === 'check:source-gates') fs.appendFileSync(path.join(process.cwd(),'.biome-noscan.jsonc'),'// changed during successful check');\nconst command = args[0];"));
    const source = value.sourceTurn();
    try {
      const denied = invokeSync(value, "validate", source.context);
      expect(denied.status, denied.stdout).toBe(1);
      expect(String(denied.json?.error)).toMatch(/generated.*differs.*derivative/i);
      expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      const calls = value.calls().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(calls).toContainEqual(["check:source-gates"]);
      expect(calls).not.toContainEqual(["typecheck:affected"]);
      expect(readFileSync(generated.artifact, "utf8")).toBe(`${generated.output}// changed during successful check`);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);
  it("rechecks edited derivatives at push and request consumption while allowing exact absent/recreated same-source retry", () => {
    const value = setup(); const generated = generatedBiomeFixture(value); validateFixture(value);
    const original = readFileSync(join(value.metadata, "vibe-session.json"), "utf8");
    const publisher = value.start("redeploy");
    try {
      writeFileSync(generated.artifact, `${generated.output}// changed before push\n`);
      const deniedPush = invokeSync(value, "push", publisher.context);
      expect(deniedPush.status, deniedPush.stdout).toBe(1);
      expect(String(deniedPush.json?.error)).toMatch(/generated.*differs.*derivative/i);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
      expect(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).toBe(original);
      rmSync(generated.artifact);
      expect(invokeSync(value, "push", publisher.context).status).toBe(0);
      writeFileSync(generated.artifact, `${generated.output}// changed before request\n`);
      const deniedRequest = invokeSync(value, "request", publisher.context);
      expect(deniedRequest.status, deniedRequest.stdout).toBe(1);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
      expect(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).toBe(original);
      writeFileSync(generated.artifact, generated.derive());
      expect(invokeSync(value, "request", publisher.context).status).toBe(0);
      expect(readFileSync(generated.artifact, "utf8")).toBe(generated.output);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(value.git(["rev-parse", "HEAD"]));
    } finally { publisher.finish(); }
  }, 30000);
  it("requires fresh transaction admission before a request-only flags or Desktop caller writes inputs", () => {
    const value = setup();
    for (const action of ["flags", "desktop"] as const) {
      const turn = value.start(action);
      try {
        const before = readFileSync(join(value.metadata, "vibe-session.json"), "utf8");
        const denied = invokeSync(value, "request", turn.context);
        expect(denied.status, denied.stdout).toBe(1);
        expect(String(denied.json?.error)).toMatch(/canonical redeploy|main.sync transaction/i);
        expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
        expect(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).toBe(before);
      } finally { turn.finish(); }
    }
  }, 30000);
  it("prepares fresh main without committing and preserves the original session base", () => {
    const value = setup();
    value.git(["checkout", "main"]);
    value.write("packages/app/upstream.ts", "upstream\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Upstream changed"]); value.git(["push", "origin", "main"]);
    const upstream = value.git(["rev-parse", "HEAD"]);
    value.git(["checkout", "vibe/test"]);
    const before = value.git(["rev-parse", "HEAD"]);
    const turn = value.start("redeploy");
    try {
      const result = invokeSync(value, "prepare", turn.context);
      expect(result.status, result.stderr).toBe(0);
      expect(value.git(["rev-parse", "HEAD"])).toBe(before);
      expect(value.git(["rev-parse", "MERGE_HEAD"])).toBe(upstream);
      expect(JSON.parse(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).baseCommit).toBe(value.baseCommit);
    } finally { turn.finish(); }
  }, 30000);
  it("blocks preparation for an actually running owned Desktop descriptor and permits the same caller after its process exits", async () => {
    const value = setup();
    value.git(["checkout", "main"]); value.write("README.md", "upstream before Desktop preparation\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Upstream before owned process"]);
    value.git(["push", "origin", "main"]); value.git(["checkout", "vibe/test"]);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); process.send('ready');"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
    let turn: ReturnType<typeof value.start> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve()); child.once("error", reject);
        child.once("exit", () => reject(new Error("Owned fixture exited before reporting ready")));
      });
      const pid = child.pid;
      if (!pid) throw new Error("Owned harmless child has no PID");
      const log = join(value.metadata, "owned-desktop.log");
      writeFileSync(log, "[vibe-profile] launching Desktop\n[startup][10:00:00.000] Desktop window visible reason=app-mounted\n");
      const launched = spawnSync(process.execPath, [join(bundleDirectory, "../vibe-sessions.mjs"), "desktop-launched",
        "--worktree", value.worktree, "--pid", String(pid), "--log", log], { cwd: value.worktree, encoding: "utf8" });
      expect(launched.status, launched.stdout).toBe(0);
      const descriptor = readFileSync(join(value.metadata, "vibe-session.json"), "utf8");
      const head = value.git(["rev-parse", "HEAD"]);
      turn = value.start("redeploy");
      const denied = invokeSync(value, "prepare", turn.context);
      expect(denied.status, denied.stdout).toBe(1);
      expect(denied.json?.status).toBe("NEEDS_DESKTOP_STOP");
      expect(value.git(["rev-parse", "HEAD"])).toBe(head);
      expect(existsSync(join(value.metadata, "MERGE_HEAD"))).toBe(false);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      expect(existsSync(join(value.metadata, "validation-calls.jsonl"))).toBe(false);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
      expect(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).toBe(descriptor);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(child.exitCode).toBeNull();
      child.kill(); await exited;
      const allowed = invokeSync(value, "prepare", turn.context);
      expect(allowed.status, allowed.stdout).toBe(0);
      expect(existsSync(join(value.metadata, "MERGE_HEAD"))).toBe(true);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(true);
      expect(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).toBe(descriptor);
      expect(value.git(["rev-parse", "HEAD"])).toBe(head);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      turn?.finish();
    }
  }, 30000);
  it("rejects a dirty excluded source fix before checks can pass bytes different from committed failing code", () => {
    const value = setup("committed-bad");
    const preparation = value.start("create");
    try { expect(invokeSync(value, "prepare", preparation.context).status).toBe(0); }
    finally { preparation.finish(); }
    value.record.localFixes.push({ ticket: "ISS-1", paths: ["apps/app/probe.ts"] }); value.save();
    value.write("apps/app/probe.ts", "export const answer = 'committed-good';\n");
    const counterfactual = spawnSync(join(value.bin, "pnpm"), ["test:affected", "--continue"],
      { cwd: value.worktree, encoding: "utf8" });
    expect(counterfactual.status).toBe(0);
    writeFileSync(join(value.metadata, "validation-calls.jsonl"), "");
    const source = value.sourceTurn();
    try {
      const failed = invokeSync(value, "validate", source.context);
      expect(failed.status, failed.stdout).toBe(1);
      expect(String(failed.json?.error)).toMatch(/committed.*inputs|differ.*HEAD/i);
      expect(value.calls()).toBe("");
      expect(value.git(["show", "HEAD:apps/app/probe.ts"])).toContain("committed-bad");
      expect(readFileSync(join(value.worktree, "apps/app/probe.ts"), "utf8")).toContain("committed-good");
      expect(JSON.parse(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).localFixes).toEqual(value.record.localFixes);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
      expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
    } finally { source.finish(); }
  }, 30000);
  it("executes actual checks for committed code with private artifacts, pushes its explicit SHA and admits only matching request consumers", () => {
    const value = setup();
    value.write(".closedloop-ai/vibe-plans/plan.md", "private plan\n");
    value.write(".closedloop-ai/vibe-plans/check-evidence.json", "{}\n");
    const result = validateFixture(value);
    expect(result.status).toBe(0);
    const calls = value.calls().trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toContainEqual(["check:source-gates"]);
    expect(calls).toContainEqual(["test:lanes"]);
    expect(calls.some((argv: string[]) => argv[0] === "exec" && argv[1] === "node")).toBe(true);
    expect(calls).toContainEqual(["turbo", "test", `--filter=...[${value.baseCommit}]`, "--continue"]);
    const head = value.git(["rev-parse", "HEAD"]);
    // ISS-12135: independent requests can deploy; only actual publisher-reserved continuations consume this proof.
    const publish = value.start("redeploy", undefined, undefined, { continuations: [
      { runtime: "codex", requestId: "reserved-flags", recordAction: "flags" },
      { runtime: "codex", requestId: "reserved-desktop", recordAction: "desktop" },
    ] });
    try {
      const pushed = invokeSync(value, "push", publish.context);
      expect(pushed.status, pushed.stdout).toBe(0);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(head);
    } finally { publish.finish(); }
    for (const action of ["flags", "desktop"] as const) {
      const consumer = value.start(action, undefined, undefined, { requestId: `reserved-${action}` });
      try {
        expect(invokeSync(value, "prepare", consumer.context).status).toBe(1);
        expect(invokeSync(value, "push", consumer.context).status).toBe(1);
        const accepted = invokeSync(value, "request", consumer.context);
        expect(accepted.status, accepted.stdout).toBe(0);
        expect(existsSync(join(value.metadata, "request.json"))).toBe(true);
        expect(invokeSync(value, "request", { ...consumer.context, recordAction: "redeploy" }).status).toBe(1);
      } finally { consumer.finish(); }
    }
    expect(readFileSync(join(value.worktree, ".closedloop-ai/vibe-plans/plan.md"), "utf8")).toBe("private plan\n");
  }, 30000);
  it("preserves normal pre-push refusal and blocks changed committed inputs before remote publication", () => {
    const value = setup();
    validateFixture(value);
    const hook = join(value.metadata, "hooks/pre-push");
    mkdirSync(join(value.metadata, "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o700);
    const publish = value.start("redeploy");
    try {
      const refused = invokeSync(value, "push", publish.context);
      expect(refused.status).toBe(1);
      expect(String(refused.json?.error)).toMatch(/pre-push\/push refused/);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
      value.write("apps/app/probe.ts", "changed after validation\n");
      expect(String(invokeSync(value, "push", publish.context).json?.error)).toMatch(/committed.*inputs/i);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
    } finally { publish.finish(); }
  }, 30000);
  it("rejects actual failing committed checks, asserted PASS and mismatched validation purpose", () => {
    const value = setup("committed-bad");
    const prepare = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const source = value.sourceTurn();
    try {
      expect(invokeSync(value, "validate", source.context, { passed: true }).status).toBe(1);
      expect(invokeSync(value, "validate", { ...source.context, publicationPurpose: "handoff" }).status).toBe(1);
      const failed = invokeSync(value, "validate", source.context);
      expect(failed.status).toBe(1);
      expect(String(failed.json?.error)).toMatch(/Required validation command failed/);
      expect(value.calls()).toContain('"check:source-gates"');
      expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
    } finally { source.finish(); }
  }, 30000);
  it("produces a true handoff no-op only for the exact verified already-published result", () => {
    const value = setup();
    validateFixture(value);
    const first = value.start("redeploy");
    try { expect(invokeSync(value, "push", first.context).status).toBe(0); } finally { first.finish(); }
    const recordFile = join(value.metadata, "vibe-session.json");
    const stored = JSON.parse(readFileSync(recordFile, "utf8"));
    stored.vercel = { lastDeployedCommit: value.git(["rev-parse", "HEAD"]), verifiedAt: "2026-10-09T00:00:00Z",
      verifiedRequestId: "verified-request" };
    stored.lastRequestId = "verified-request";
    writeFileSync(recordFile, JSON.stringify(stored));
    validateFixture(value, "handoff");
    const hook = join(value.metadata, "hooks/pre-push");
    mkdirSync(join(value.metadata, "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o700);
    const handoff = value.start("redeploy", "handoff", undefined, { continuations: [
      { runtime: "codex", requestId: "handoff-flags-continuation", recordAction: "flags" },
    ] });
    try {
      const result = invokeSync(value, "push", handoff.context);
      expect(result.status, result.stdout).toBe(0);
      expect(result.json?.mainSync).toMatchObject({ pushed: false, alreadyPublished: true });
      const before = readFileSync(recordFile, "utf8");
      const request = invokeSync(value, "request", handoff.context);
      expect(request.status, request.stdout).toBe(0);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
      expect(readFileSync(recordFile, "utf8")).toBe(before);
      expect(request.json?.mainSync).toMatchObject({ alreadyPublished: true });
    } finally { handoff.finish(); }
    const snapshot = readFileSync(value.record.flagSnapshot.file, "utf8");
    const flags = value.start("flags", "handoff", undefined, { requestId: "handoff-flags-continuation" });
    try {
      const requested = invokeSync(value, "request", flags.context);
      expect(requested.status, requested.stdout).toBe(0);
      expect(requested.json?.workflow).toBe("vibe-environment-dispatch.yml");
      expect(existsSync(join(value.metadata, "request.json"))).toBe(true);
      expect(readFileSync(value.record.flagSnapshot.file, "utf8")).toBe(snapshot);
    } finally { flags.finish(); }
  }, 30000);
  it("keeps the actual native registration after its old definition directory is absent and current helpers supply grants", () => {
    const value = setup();
    const prepare = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const initialSource = value.sourceTurn(); initialSource.finish();
    const ledgerFile = join(value.metadata, "vibe-writer.json");
    const original = JSON.parse(readFileSync(ledgerFile, "utf8"));
    const currentRoot = currentSyncDefinitions(value);
    rmSync(value.agentRoot, { recursive: true });
    const source = value.sourceTurn(undefined, currentRoot);
    try { expect(invokeSync(value, "validate", source.context).status).toBe(0); } finally { source.finish(); }
    const after = JSON.parse(readFileSync(ledgerFile, "utf8"));
    expect(after.workerId).toBe(original.workerId);
    expect(after.binding).toEqual(original.binding);
    expect(after.binding.agentRoot).toBe(value.agentRoot);
    expect(existsSync(value.agentRoot)).toBe(false);
    const publisher = value.start("redeploy", undefined, currentRoot);
    try { expect(invokeSync(value, "push", publisher.context).status).toBe(0); } finally { publisher.finish(); }
  }, 30000);
  it("uses one captured main through validation and publishes that exact SHA after the remote main advances", () => {
    const value = setup();
    const preparation = value.start("create");
    try { expect(invokeSync(value, "prepare", preparation.context).status).toBe(0); } finally { preparation.finish(); }
    const captured = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    value.git(["checkout", "main"]); value.write("README.md", "main advanced during transaction\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Later main"]); value.git(["push", "origin", "main"]);
    const newerMain = value.git(["rev-parse", "HEAD"]); value.git(["checkout", "vibe/test"]);
    const source = value.sourceTurn();
    try { expect(invokeSync(value, "validate", source.context).status).toBe(0); } finally { source.finish(); }
    const publisher = value.start("redeploy");
    try { expect(invokeSync(value, "push", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    const after = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    expect(after.mainSha).toBe(captured.mainSha);
    expect(after.mainSha).not.toBe(newerMain);
    expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(captured.startingHead);
  }, 30000);
  it("retains a real conflict for the same writer and never commits or pushes from preparation", () => {
    const value = setup();
    value.write("apps/app/probe.ts", "feature side\n"); value.git(["add", "."]); value.git(["commit", "-m", "Feature side"]);
    const before = value.git(["rev-parse", "HEAD"]);
    value.git(["checkout", "main"]); value.write("apps/app/probe.ts", "main side\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Main side"]); value.git(["push", "origin", "main"]);
    value.git(["checkout", "vibe/test"]);
    const prepare = value.start("redeploy");
    try {
      const conflict = invokeSync(value, "prepare", prepare.context);
      expect(conflict.status).toBe(1);
      expect(String(conflict.json?.error)).toMatch(/SAME writer.*conflict/);
      expect(value.git(["rev-parse", "HEAD"])).toBe(before);
      expect(value.git(["diff", "--name-only", "--diff-filter=U"])).toBe("apps/app/probe.ts");
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
    } finally { prepare.finish(); }
  }, 30000);
  it("rejects guessed transaction backfill, wrong owner and stale purpose before publication", () => {
    const value = setup(); validateFixture(value);
    const publisher = value.start("redeploy");
    try {
      for (const context of [
        { ...publisher.context, mainSyncTransactionId: undefined },
        { ...publisher.context, workerId: "another-publisher" },
        { ...publisher.context, publicationPurpose: "handoff" },
        { ...publisher.context, lease: "11111111-1111-4111-8111-111111111111" },
      ]) expect(invokeSync(value, "push", context).status).toBe(1);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
    } finally { publisher.finish(); }
  }, 30000);
  it("runs canonical prototype checks only as the same writer and admits its share tuple, not an app request", () => {
    const value = setup();
    value.git(["branch", "-m", "prototype/test"]);
    const recordFile = join(value.metadata, "vibe-session.json");
    const record = JSON.parse(readFileSync(recordFile, "utf8")); record.branch = "prototype/test"; record.mode = null; record.vercel = null;
    writeFileSync(recordFile, JSON.stringify(record));
    value.write("apps/prototypes/app/p/test/decisions.md", "# Decisions\n- existing decision\n");
    value.write("apps/prototypes/lib/registry.generated.ts", "export const prototypes = [];\n");
    value.write(".claude/skills/prototype-approve/scripts/read-decision-log.mjs",
      "import {readFileSync} from 'node:fs'; if (!readFileSync(process.argv[2], 'utf8').startsWith('# Decisions')) process.exit(1);\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Owned prototype fixture"]);
    const prepare = value.start("share");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const source = value.sourceTurn();
    try { expect(invokeSync(value, "validate", source.context).status).toBe(0); } finally { source.finish(); }
    const calls = value.calls().trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toContainEqual(["--filter", "prototypes", "generate:registry"]);
    expect(calls).toContainEqual(["--filter", "prototypes", "typecheck"]);
    expect(calls).toContainEqual(["--filter", "prototypes", "test"]);
    const share = value.start("share");
    try {
      expect(invokeSync(value, "share", share.context).status).toBe(0);
      expect(invokeSync(value, "request", share.context).status).toBe(1);
      expect(invokeSync(value, "push", share.context).status).toBe(0);
    } finally { share.finish(); }
  }, 30000);
  it("rejects source generation that changes committed bytes instead of minting a pass receipt", () => {
    const value = setup();
    const prepare = value.start("create");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const executable = join(value.bin, "pnpm");
    const fixtureProgram = readFileSync(executable, "utf8");
    writeFileSync(executable, fixtureProgram.replace("const command = args[0];",
      "if (args[0] === 'check:source-gates') fs.writeFileSync(path.join(process.cwd(), 'apps/app/probe.ts'), 'generated source change');\nconst command = args[0];"));
    const source = value.sourceTurn();
    try {
      expect(invokeSync(value, "validate", source.context).status).toBe(1);
      expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation).toBeUndefined();
      expect(readFileSync(join(value.worktree, "apps/app/probe.ts"), "utf8")).toBe("generated source change");
    } finally { source.finish(); }
  }, 30000);
  it("attributes imported tests/forbidden paths to captured main before ROOT commit without hiding feature-authored tests", () => {
    const value = setup();
    value.write("packages/app/feature.ts", "feature source\n");
    value.write("apps/app/authored.test.ts", "early feature test\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Feature authored paths"]);
    value.git(["checkout", "main"]);
    value.write("apps/app/imported.test.ts", "upstream test\n");
    value.write(".github/upstream.yml", "upstream workflow\n");
    value.write("apps/api/upstream.ts", "upstream backend\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Main imports"]); value.git(["push", "origin", "main"]);
    const mainSha = value.git(["rev-parse", "HEAD"]); value.git(["checkout", "vibe/test"]);
    const prepare = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const inventoryScript = join(bundleDirectory, "../../..", "handoff/scripts/handoff-inventory.mjs");
    const inventory = () => {
      const result = spawnSync(process.execPath, [inventoryScript, "--worktree", value.worktree, "--phase", "build"],
        { encoding: "utf8", cwd: value.worktree });
      expect(result.error).toBeUndefined(); return JSON.parse(result.stdout);
    };
    const pending = inventory();
    expect(pending.baseCommit).toBe(mainSha);
    expect(pending.mainSync.originalBase).toBe(value.baseCommit);
    expect(pending.mainSync.pendingMerge).toBe(true);
    expect(pending.blocking.mainSyncMergeCommitted).toBe(false);
    expect(pending.changedFiles.map((file: { path: string }) => file.path).sort()).toEqual([
      "apps/app/authored.test.ts", "packages/app/feature.ts",
    ]);
    expect(pending.forbidden).toEqual([]);
    expect(pending.backendChanged).toBe(false);
    const committed = spawnSync(process.execPath, [join(bundleDirectory, "../commit-worktree.mjs"),
      "--worktree", value.worktree, "--subject", "ISS-1: Merge reviewed main"], { encoding: "utf8" });
    expect(committed.status, committed.stdout || committed.stderr).toBe(0);
    expect(JSON.parse(committed.stdout).merge).toBe(true);
    const finished = inventory();
    expect(finished.mainSync.pendingMerge).toBe(false);
    expect(finished.changedFiles.some((file: { path: string }) => file.path === "apps/app/authored.test.ts")).toBe(true);
  }, 30000);
  it("retains original feature test history when fresh main absorbs identical bytes", () => {
    const value = setup();
    const path = "apps/app/early.test.ts";
    value.write(path, "original feature-authored test\n");
    value.write("packages/app/feature.ts", "remaining feature source\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Feature test before handoff"]);
    const featureCommit = value.git(["rev-parse", "HEAD"]);
    value.git(["checkout", "main"]);
    value.write(path, "original feature-authored test\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Main independently absorbs identical test"]);
    value.git(["push", "origin", "main"]); value.git(["checkout", "vibe/test"]);
    const prepare = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
    const receipt = () => JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    expect(receipt().featureTestHistory).toContainEqual({ commit: featureCommit, path });
    expect(value.git(["diff", "--name-only", receipt().mainSha])).toBe("packages/app/feature.ts");
    const committed = spawnSync(process.execPath, [join(bundleDirectory, "../commit-worktree.mjs"),
      "--worktree", value.worktree, "--subject", "ISS-1: Merge reviewed identical test"], { encoding: "utf8" });
    expect(committed.status, committed.stdout || committed.stderr).toBe(0);
    const rootCommit = value.git(["rev-parse", "HEAD"]);
    expect(value.git(["rev-parse", "HEAD^1"])).toBe(featureCommit);
    const next = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", next.context).status).toBe(0); } finally { next.finish(); }
    expect(receipt().originalBase).toBe(value.baseCommit);
    expect(receipt().startingHead).toBe(rootCommit);
    expect(receipt().featureTestHistory).toContainEqual({ commit: featureCommit, path });
    const inventory = spawnSync(process.execPath, [join(bundleDirectory, "../../..", "handoff/scripts/handoff-inventory.mjs"),
      "--worktree", value.worktree, "--phase", "build"], { encoding: "utf8" });
    expect(inventory.status, inventory.stdout || inventory.stderr).toBe(0);
    const result = JSON.parse(inventory.stdout);
    expect(result.changedFiles.map((file: { path: string }) => file.path)).toEqual(["packages/app/feature.ts"]);
    expect(result.mainSync.featureTestHistory).toContainEqual({ commit: featureCommit, path });
  }, 30000);
  it("retains newly combined merge test assertions but excludes exact upstream adoption", () => {
    const value = setup();
    const path = "apps/app/conflict.test.ts";
    value.write(path, "feature assertion\n"); value.git(["add", "."]);
    value.git(["commit", "-m", "Feature assertions"]);
    value.git(["checkout", "main"]); value.write(path, "upstream assertion\n");
    value.write("apps/app/imported.test.ts", "exact upstream assertion\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Main assertions"]); value.git(["push", "origin", "main"]);
    value.git(["checkout", "vibe/test"]);
    const preparation = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", preparation.context).status).toBe(1); } finally { preparation.finish(); }
    value.write(path, "new combined assertion\n"); value.git(["add", path]);
    const root = spawnSync(process.execPath, [join(bundleDirectory, "../commit-worktree.mjs"),
      "--worktree", value.worktree, "--subject", "ISS-1: Root commits resolved merge"], { encoding: "utf8" });
    expect(root.status, root.stdout || root.stderr).toBe(0);
    const mergeCommit = value.git(["rev-parse", "HEAD"]);
    const next = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", next.context).status).toBe(0); } finally { next.finish(); }
    const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    expect(receipt.featureTestHistory).toContainEqual({ commit: mergeCommit, path });
    expect(receipt.featureTestHistory.some((entry: { path: string }) => entry.path === "apps/app/imported.test.ts")).toBe(false);
  }, 30000);
  it("executes the existing full backend handoff matrix without imposing it on build checks", () => {
    const value = setup();
    value.write("apps/api/change.ts", "backend source\n"); value.git(["add", "."]);
    value.git(["commit", "-m", "Backend feature fixture"]);
    validateFixture(value, "build");
    const calls = () => value.calls().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(calls()).not.toContainEqual(["verify"]);
    writeFileSync(join(value.metadata, "validation-calls.jsonl"), "");
    validateFixture(value, "handoff");
    for (const command of [["verify"], ["test"], ["test:lint"], ["test:skills"], ["vibe", "storybook-diff"]]) {
      expect(calls()).toContainEqual(command);
    }
    const publication = value.start("redeploy", "build");
    try { expect(invokeSync(value, "push", publication.context).status).toBe(1); } finally { publication.finish(); }
    expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
  }, 60000);
  it("preserves symlink evidence and rejects stale operator provenance before preparing or requesting", () => {
    const value = setup();
    validateFixture(value);
    const file = join(value.metadata, "vibe-main-sync.json");
    const original = readFileSync(file, "utf8");
    const stale = JSON.parse(original); stale.operator.id = "other-operator";
    writeFileSync(file, JSON.stringify(stale));
    const publisher = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", publisher.context).status).toBe(1); } finally { publisher.finish(); }
    expect(JSON.parse(readFileSync(file, "utf8")).operator.id).toBe("other-operator");
    const target = join(value.metadata, "untouched-proof.json"); writeFileSync(target, original);
    rmSync(file); symlinkSync(target, file);
    const consumer = value.start("flags");
    try { expect(invokeSync(value, "request", consumer.context).status).toBe(1); } finally { consumer.finish(); }
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
    expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
  }, 30000);
  it("allows retries only in the same actual publishing turn after a normal hook refusal", () => {
    const value = setup();
    validateFixture(value);
    const hook = join(value.metadata, "hooks/pre-push");
    mkdirSync(join(value.metadata, "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const publication = value.start("redeploy", undefined, undefined, { continuations: [
      { runtime: "codex", requestId: "retry-operation-flags", recordAction: "flags" },
    ] });
    try {
      expect(invokeSync(value, "push", publication.context).status).toBe(1);
      rmSync(hook);
      expect(invokeSync(value, "push", publication.context).status).toBe(0);
      expect(invokeSync(value, "push", publication.context).status).toBe(0);
    } finally { publication.finish(); }
    const later = value.start("redeploy");
    try {
      expect(invokeSync(value, "push", later.context).status).toBe(1);
      expect(invokeSync(value, "request", later.context).status).toBe(1);
    } finally { later.finish(); }
    const consumer = value.start("flags", undefined, undefined, { requestId: "retry-operation-flags" });
    try { expect(invokeSync(value, "request", consumer.context).status).toBe(0); } finally { consumer.finish(); }
  }, 30000);
  it("requires fresh preparation when a later publisher tries to reuse a consumed transaction", () => {
    const value = setup();
    validateFixture(value);
    const first = value.start("redeploy");
    try { expect(invokeSync(value, "push", first.context).status).toBe(0); } finally { first.finish(); }
    const published = value.git(["rev-parse", "HEAD"]);
    value.git(["checkout", "main"]); value.write("README.md", "new upstream behavior\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Main advanced after publication"]);
    value.git(["push", "origin", "main"]); value.git(["checkout", "vibe/test"]);
    const later = value.start("redeploy");
    try {
      const result = invokeSync(value, "push", later.context);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/fresh preparation|canonical redeploy/i);
    } finally { later.finish(); }
    expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(published);
    expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
  }, 30000);
  it.each(["flags", "desktop"] as const)("rejects independent %s deployment request after main advances without mutating inputs", (action) => {
    const value = setup();
    validateFixture(value);
    const publisher = value.start("redeploy");
    try { expect(invokeSync(value, "push", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    value.git(["checkout", "main"]); value.write("README.md", "main advanced before independent request\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Main advanced"]); value.git(["push", "origin", "main"]);
    value.git(["checkout", "vibe/test"]);
    const turn = value.start(action);
    const before = readFileSync(join(value.metadata, "vibe-session.json"), "utf8");
    try {
      const denied = invokeSync(value, "request", turn.context);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
      expect(readFileSync(join(value.metadata, "vibe-session.json"), "utf8")).toBe(before);
      expect(denied.status, denied.stdout).toBe(1);
    } finally { turn.finish(); }
  }, 30000);
  it("records incomplete build E2E without invoking a bare unsupported Electron lane", () => {
    const value = setup();
    value.write("apps/desktop/test/reveal-window.spec.ts", "revealWindow: true synthetic scenario\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Desktop reveal scenario fixture"]);
    const preparation = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", preparation.context).status).toBe(0); } finally { preparation.finish(); }
    const source = value.sourceTurn();
    try {
      const failed = invokeSync(value, "validate", source.context);
      expect(existsSync(join(value.metadata, "unsafe-lane-spawned"))).toBe(false);
      expect(failed.status, failed.stdout).toBe(0);
      const validation = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).validation;
      expect(validation.e2eLimitations[0].reason).toMatch(/displayless/i);
      expect(failed.json?.mainSync).toMatchObject({ publicationReady: true, requiredE2eComplete: false });
    } finally { source.finish(); }
  }, 30000);
  it("locally ROOT commits reviewed dirty source before preparation, then commits the merge and publishes checked inputs", () => {
    const value = setup();
    value.git(["checkout", "main"]); value.write("README.md", "fresh main\n"); value.git(["add", "."]);
    value.git(["commit", "-m", "Main before reviewed deliverable"]); value.git(["push", "origin", "main"]);
    value.git(["checkout", "vibe/test"]);
    const original = value.git(["rev-parse", "HEAD"]);
    value.write("apps/app/probe.ts", "reviewed deliverable source\n");
    value.write(".closedloop-ai/vibe-plans/local.md", "private technical plan\n");
    const source = value.sourceTurn(); source.finish();
    const registered = readFileSync(join(value.metadata, "vibe-writer.json"), "utf8");
    const dirty = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", dirty.context).status).toBe(1); } finally { dirty.finish(); }
    const commit = (subject: string) => spawnSync(process.execPath, [join(bundleDirectory, "../commit-worktree.mjs"),
      "--worktree", value.worktree, "--subject", subject], { encoding: "utf8" });
    const hook = join(value.metadata, "hooks/pre-commit"); mkdirSync(join(value.metadata, "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nprintf 'checked\\n' >> .git/commit-hooks\n", { mode: 0o700 });
    expect(commit("ISS-1: Root locally commits reviewed deliverable").status).toBe(0);
    expect(value.git(["rev-parse", "HEAD"])).not.toBe(original);
    expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"])).toBe("");
    expect(value.git(["ls-tree", "-r", "--name-only", "HEAD", "--", ".closedloop-ai/vibe-plans"])).toBe("");
    const prepared = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", prepared.context).json?.mainSync).toMatchObject({ requiresCommit: true }); }
    finally { prepared.finish(); }
    expect(commit("ISS-1: Root commits reviewed main merge").status).toBe(0);
    const validation = value.sourceTurn();
    try { expect(invokeSync(value, "validate", validation.context).status).toBe(0); } finally { validation.finish(); }
    expect(JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8")).binding).toEqual(JSON.parse(registered).binding);
    const pub = value.start("redeploy");
    try { expect(invokeSync(value, "push", pub.context).status).toBe(0); } finally { pub.finish(); }
    expect(readFileSync(join(value.metadata, "commit-hooks"), "utf8")).toContain("checked");
    expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(value.git(["rev-parse", "HEAD"]));
  }, 30000);
  it("binds reserved continuation intent to the first actual consumer and invalidates it on new preparation", () => {
    const value = setup(); validateFixture(value);
    const publisher = value.start("redeploy", undefined, undefined, { continuations: [
      { runtime: "codex", requestId: "intent-one", recordAction: "flags" },
    ] });
    try { expect(invokeSync(value, "push", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    const wrong = value.start("desktop", undefined, undefined, { requestId: "intent-one" });
    try { expect(invokeSync(value, "request", wrong.context).status).toBe(1); } finally { wrong.finish(); }
    const first = value.start("flags", undefined, undefined, { requestId: "intent-one" });
    try {
      expect(invokeSync(value, "request", { ...first.context, mainSyncRequestContinuations: [
        { runtime: "codex", requestId: "intent-one", recordAction: "flags" },
      ] }).status).toBe(1);
      expect(invokeSync(value, "request", first.context).status).toBe(0);
      expect(invokeSync(value, "request", first.context).status).toBe(0);
    } finally { first.finish(); }
    const replay = value.start("flags", undefined, undefined, { requestId: "intent-one" });
    try { expect(invokeSync(value, "request", replay.context).status).toBe(1); } finally { replay.finish(); }
    validateFixture(value);
    const stale = value.start("flags", undefined, undefined, { requestId: "intent-one" });
    try { expect(invokeSync(value, "request", stale.context).status).toBe(1); } finally { stale.finish(); }
  }, 30000);
  it("executes preparation, source validation, exact push and request-only consumption through the production Claude launcher", () => {
    const value = setup();
    const run = (agentName: string, recordAction: string, input: string, requestId: string, transactionId?: string,
      continuations?: { runtime: "claude"; requestId: string; recordAction: "flags" }[], mainSyncValidation?: unknown) => {
      const result = spawnSync(process.execPath, [join(bundleDirectory, "claude-worker.mjs")], { cwd: value.worktree,
        input: JSON.stringify({ worktree: value.worktree, agentRoot: value.agentRoot, agentName, recordAction, input,
          requestId, mode: "record", exclusiveRecordTurn: true, capabilities: [...graph, recordWrite],
          publicationPurpose: "build",
          ...(transactionId ? { mainSyncTransactionId: transactionId } : {}),
          ...(mainSyncValidation ? { mainSyncValidation } : {}),
          ...(continuations ? { mainSyncRequestContinuations: continuations } : {}) }),
        encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${value.bin}:${process.env.PATH}` } });
      expect(result.error).toBeUndefined(); return { code: result.status, output: JSON.parse(result.stdout) };
    };
    const initial = run("vibe-change-worker", "progress", "MAIN_SYNC_INPUTS", "sdk-inputs");
    expect(initial.code, JSON.stringify(initial.output)).toBe(0);
    const prepare = run("vibe-environment-worker", "create", "MAIN_SYNC_PREPARE", "sdk-prepare");
    expect(prepare.code, JSON.stringify(prepare.output)).toBe(0);
    const transactionId = prepare.output.data.mainSyncResult.mainSync.transactionId;
    const ready = run("vibe-change-worker", "progress", "MAIN_SYNC_INPUTS", "sdk-ready", transactionId);
    expect(ready.code, JSON.stringify(ready.output)).toBe(0);
    const checked = run("vibe-change-worker", "progress", "MAIN_SYNC_VALIDATE", "sdk-validate", transactionId, undefined,
      ready.output.data.mainSyncResult.mainSync.validationWitness);
    expect(checked.code, JSON.stringify(checked.output)).toBe(0);
    const registered = JSON.parse(readFileSync(join(value.metadata, "vibe-writer.json"), "utf8"));
    expect(registered.runtime).toBe("claude");
    expect(registered.workerId).toBe(checked.output.workerId);
    expect(checked.output.workerId).toBe(initial.output.workerId);
    const pushed = run("vibe-environment-worker", "redeploy", "MAIN_SYNC_PUSH", "sdk-push", transactionId,
      [{ runtime: "claude", requestId: "sdk-flags", recordAction: "flags" }]);
    expect(pushed.code, JSON.stringify(pushed.output)).toBe(0);
    const requested = run("vibe-environment-worker", "flags", "MAIN_SYNC_REQUEST", "sdk-flags", transactionId);
    expect(requested.code, JSON.stringify(requested.output)).toBe(0);
    const wrongRole = run("vibe-environment-worker", "flags", "MAIN_SYNC_PUSH", "sdk-denied", transactionId);
    expect(wrongRole.code).toBe(1);
    expect(existsSync(join(value.metadata, "vibe-record-turn.lock"))).toBe(false);
    expect(value.calls()).toContain('"check:source-gates"');
  }, 60000);
});
