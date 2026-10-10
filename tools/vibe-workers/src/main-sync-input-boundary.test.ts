import { chmodSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokeSync, syncFixture, validateFixture, currentSyncDefinitions } from "./main-sync-test-fixtures.js";
import { prismaInputFixture, fumadocsInputFixture, buildInfoInputFixture, largeProducerInputFixture, nextInputFixture, pureInputFixture,
  docsInputFixture, huskyInputFixture, desktopPrismaInputFixture } from "./main-sync-input-test-fixtures.js";
import { gzipSync, gunzipSync } from "node:zlib";
import { originIdentity } from "./main-sync-input-files.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
function setup() { const value = syncFixture(); fixtures.push(value); return value; }

describe("production committed-input privacy and origin boundaries", () => {
  it.each(["reader", "replay"] as const)("blocks a retained report selected as %s input without reading or removing it", (kind) => {
    const value = setup();
    const output = ".vitest/blob/blob.json";
    value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n.vitest/\n`);
    if (kind === "reader") value.write("apps/app/probe.ts", "import {readFileSync} from 'node:fs';\nreadFileSync('../../.vitest/blob/blob.json');\n");
    else {
      const pkg = JSON.parse(readFileSync(join(value.worktree, "package.json"), "utf8"));
      pkg.scripts["test:affected"] = "vitest --merge-reports .vitest/blob";
      value.write("package.json", JSON.stringify(pkg));
    }
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic selected retained-report reader"]);
    const body = "retained failed evidence is not current PASS\n";
    value.write(output, body);
    const turn = value.start("redeploy");
    try {
      const result = invokeSync(value, "prepare", turn.context);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/retained report|replay/i);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(readFileSync(join(value.worktree, output), "utf8")).toBe(body);
    } finally { turn.finish(); }
  }, 30000);

  it("preserves retained failed reports when the fixed default checks do not consume them", () => {
    const value = setup();
    const output = ".vitest/blob/blob.json";
    value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n.vitest/\n`);
    value.git(["add", ".gitignore"]); value.git(["commit", "-m", "Synthetic reporter output contract"]);
    value.write(output, "{\"failed\":true}\n");
    expect(validateFixture(value).status).toBe(0);
    expect(readFileSync(join(value.worktree, output), "utf8")).toBe("{\"failed\":true}\n");
  }, 30000);
  it("preserves an ignored uncollected private diagnostic regardless of its executable extension", () => {
    const value = setup();
    const path = ".closedloop-ai/vibe-plans/probes/retained-diagnostic.test.tsx";
    const content = "throw new Error('retained diagnostic must never execute');\n";
    value.write(path, content);
    const result = validateFixture(value);
    expect(result.status, result.stdout).toBe(0);
    expect(readFileSync(join(value.worktree, path), "utf8")).toBe(content);
    expect(value.calls()).toContain('"check:source-gates"');
    expect(value.git(["ls-files", path])).toBe("");
  }, 30000);

  it("blocks a committed explicit private-code import before capture or execution", () => {
    const value = setup();
    const path = ".closedloop-ai/vibe-plans/probes/retained-diagnostic.test.tsx";
    value.write(path, "throw new Error('private input');\n");
    value.write("apps/app/probe.ts", `import '../../${path}';\n`);
    value.git(["add", "apps/app/probe.ts"]);
    value.git(["commit", "-m", "Synthetic consumed private input"]);
    const turn = value.start("redeploy");
    try {
      const result = invokeSync(value, "prepare", turn.context);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/private|uncommitted executable/i);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      expect(readFileSync(join(value.worktree, path), "utf8")).toContain("private input");
    } finally { turn.finish(); }
  }, 30000);

  it("blocks a root collector whose wildcard reaches the canonical private diagnostic", () => {
    const value = setup();
    const path = ".closedloop-ai/vibe-plans/probes/retained-diagnostic.test.tsx";
    value.write(path, "throw new Error('must remain uncollected');\n");
    value.write("vitest.config.ts", "export default {test:{include:['**/*.test.tsx']}};\n");
    value.git(["add", "vitest.config.ts"]); value.git(["commit", "-m", "Synthetic root collector expansion"]);
    const turn = value.start("redeploy");
    try {
      const result = invokeSync(value, "prepare", turn.context);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/private.*collector/i);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(readFileSync(join(value.worktree, path), "utf8")).toContain("must remain uncollected");
    } finally { turn.finish(); }
  }, 30000);

  it("honors the owning literal collector exclusion without opening the archived diagnostic", () => {
    const value = setup();
    const path = ".closedloop-ai/vibe-plans/probes/retained-diagnostic.test.tsx";
    value.write(path, "throw new Error('preserved and excluded');\n");
    value.write("vitest.config.ts", "export default {test:{include:['**/*.test.tsx'],exclude:['.closedloop-ai/**']}};\n");
    value.git(["add", "vitest.config.ts"]); value.git(["commit", "-m", "Synthetic literal private exclusion"]);
    expect(validateFixture(value).status).toBe(0);
    expect(readFileSync(join(value.worktree, path), "utf8")).toContain("preserved and excluded");
  }, 30000);

  it.each(["private-parent", "report-parent", "unignored", "staged"] as const)("rejects %s evidence before capture and preserves its bytes", (failure) => {
    const value = setup();
    const body = "retained private failure\n";
    const path = failure === "report-parent" ? ".vitest/blob/blob.json" : ".closedloop-ai/vibe-plans/probes/retained.test.tsx";
    if (failure === "report-parent") {
      value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n.vitest/\n`);
      value.git(["add", ".gitignore"]); value.git(["commit", "-m", "Synthetic report owner"]);
    }
    value.write(path, body);
    if (failure === "private-parent" || failure === "report-parent") {
      const parent = failure === "private-parent" ? ".closedloop-ai/vibe-plans/probes" : ".vitest/blob";
      value.write("../retained-evidence/retained.test.tsx", body);
      value.write("../retained-evidence/blob.json", body);
      rmSync(join(value.worktree, parent), { recursive: true });
      symlinkSync(join(value.base, "retained-evidence"), join(value.worktree, parent));
    }
    if (failure === "unignored") {
      value.write(".gitignore", "node_modules/\n.control/\n"); value.git(["add", ".gitignore"]);
      value.git(["commit", "-m", "Synthetic unignored evidence"]);
    }
    if (failure === "staged") value.git(["add", "-f", path]);
    const turn = value.start("redeploy");
    try {
      const result = invokeSync(value, "prepare", turn.context);
      expect(result.status, result.stdout).toBe(1);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(readFileSync(join(value.worktree, path), "utf8")).toBe(body);
    } finally { turn.finish(); }
  }, 30000);

  it("exposes canonical source-owned readiness before any captured-main receipt exists", () => {
    const value = setup();
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(result.json?.mainSync).toMatchObject({ status: "DONE", phase: "input-readiness" });
      const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
      expect(receipt.phase).toBe("input-readiness");
      expect(receipt).not.toHaveProperty("mainSha");
      expect(receipt).not.toHaveProperty("validation");
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it("retains original feature-test history across captured readiness and a later capture without inferring phase", () => {
    const value = setup();
    const path = "apps/app/retained-feature.test.ts";
    value.write(path, "export const historicalFeatureAssertion = true;\n");
    value.git(["add", path]); value.git(["commit", "-m", "Synthetic original feature-test history"]);
    const original = value.git(["rev-parse", "HEAD"]);
    expect(validateFixture(value).status).toBe(0);
    const file = join(value.metadata, "vibe-main-sync.json");
    const before = JSON.parse(readFileSync(file, "utf8"));
    expect(before.featureTestHistory).toContainEqual({ commit: original, path });
    const source = value.sourceTurn();
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); } finally { source.finish(); }
    const ready = JSON.parse(readFileSync(file, "utf8"));
    expect(ready.phase).toBe("input-readiness");
    expect(ready.previous.featureTestHistory).toEqual(before.featureTestHistory);
    expect(ready.previous.importedCommits).toEqual(before.importedCommits);
    expect(ready.originalBase).toBe(value.baseCommit);
    const next = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", next.context).status).toBe(0); } finally { next.finish(); }
    const captured = JSON.parse(readFileSync(file, "utf8"));
    expect(captured.featureTestHistory).toEqual(before.featureTestHistory);
    expect(captured.originalBase).toBe(before.originalBase);
    expect(captured.featureTestHistory[0]).not.toHaveProperty("testAuthoringAuthorized");
  }, 60000);

  it("prepares input readiness from current helpers with the original native actor and an absent old cache", () => {
    const value = setup();
    const first = value.sourceTurn(); first.finish();
    const ledger = join(value.metadata, "vibe-writer.json");
    const original = JSON.parse(readFileSync(ledger, "utf8"));
    const current = currentSyncDefinitions(value);
    rmSync(value.agentRoot, { recursive: true });
    const source = value.sourceTurn(undefined, current);
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); } finally { source.finish(); }
    const after = JSON.parse(readFileSync(ledger, "utf8"));
    expect(after.workerId).toBe(original.workerId);
    expect(after.binding).toEqual(original.binding);
    expect(existsSync(value.agentRoot)).toBe(false);
    const publisher = value.start("redeploy", undefined, current);
    try { expect(invokeSync(value, "prepare", publisher.context).status).toBe(0); } finally { publisher.finish(); }
  }, 30000);

  it("verifies canonical generated dependencies against a pristine committed producer before capture", () => {
    const value = setup();
    const generated = prismaInputFixture(value);
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(result.json?.mainSync).toMatchObject({ status: "DONE", generatedFiles: 1 });
      expect(readFileSync(join(value.worktree, generated.output), "utf8")).toBe(generated.body);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it("stores and consumes a real-sized 8533-file owner within the unchanged one-MiB receipt", () => {
    const value = setup();
    largeProducerInputFixture(value);
    const source = value.sourceTurn();
    try {
      const ready = invokeSync(value, "inputs", source.context);
      expect(ready.status, ready.stdout).toBe(0);
      expect(readFileSync(join(value.metadata, "vibe-main-sync.json")).byteLength).toBeLessThanOrEqual(1024 * 1024);
    } finally { source.finish(); }
    const publisher = value.start("redeploy");
    try {
      const prepared = invokeSync(value, "prepare", publisher.context);
      expect(prepared.status, prepared.stdout).toBe(0);
    } finally { publisher.finish(); }
  }, 60000);

  it("deduplicates the resolved canonical Next package while independently binding both app refs and complete output sets", () => {
    const value = setup();
    const next = nextInputFixture(value);
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      const state = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
      expect(state.inputs.packages).toHaveLength(1);
      expect(state.inputs.producers).toHaveLength(2);
      expect(state.inputs.producers.map((producer: { ownerPath: string }) => producer.ownerPath)).toEqual(["node_modules/next", "node_modules/next"]);
      expect(state.inputs.files.map((file: { path: string }) => file.path).sort()).toEqual(next.files.sort());
    } finally { source.finish(); }
    const publisher = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", publisher.context).status).toBe(0); } finally { publisher.finish(); }
  }, 30000);

  it("refuses an oversized fresh capture before atomic save and retains the exact prior receipt and feature tree", () => {
    const value = setup();
    const first = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", first.context).status).toBe(0); } finally { first.finish(); }
    const file = join(value.metadata, "vibe-main-sync.json");
    const before = readFileSync(file);
    const head = value.git(["rev-parse", "HEAD"]);
    value.git(["checkout", "main"]);
    const prefix = `upstream/${"a".repeat(120)}/${"b".repeat(120)}`;
    for (let index = 0; index < 4500; index++) value.write(`${prefix}/imported-${String(index).padStart(5, "0")}.ts`, "export {};\n");
    value.git(["add", "upstream"]); value.git(["commit", "-qm", "Synthetic oversized captured import inventory"]);
    value.git(["push", "origin", "main"]); value.git(["checkout", "vibe/test"]);
    const publisher = value.start("redeploy");
    try {
      const result = invokeSync(value, "prepare", publisher.context);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/private byte bound/);
      expect(readFileSync(file)).toEqual(before);
      expect(value.git(["rev-parse", "HEAD"])).toBe(head);
      expect(existsSync(join(value.metadata, "MERGE_HEAD"))).toBe(false);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
    } finally { publisher.finish(); }
  }, 60000);

  it.each(["duplicate-ref", "missing-ref", "wrong-directory", "digest", "base64", "bomb", "path", "duplicate-name", "count", "extra", "mode", "link"] as const)(
    "blocks compact owner %s tamper at the production consumer before fetch", (failure) => {
    const value = setup();
    prismaInputFixture(value);
    const source = value.sourceTurn();
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); } finally { source.finish(); }
    const file = join(value.metadata, "vibe-main-sync.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    const owner = state.inputs.packages[0];
    if (failure === "duplicate-ref") state.inputs.packages.push({ ...owner });
    if (failure === "missing-ref") state.inputs.packages = [];
    if (failure === "wrong-directory") { owner.path = "node_modules/different"; state.inputs.producers[0].ownerPath = owner.path; }
    if (failure === "digest") owner.sha256 = "0".repeat(64);
    if (failure === "base64") owner.names = "not canonical base64";
    if (failure === "bomb") owner.names = gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 32)).toString("base64");
    if (failure === "path") owner.names = gzipSync(Buffer.from('["../auth-state.json"]')).toString("base64");
    if (failure === "duplicate-name") {
      const names = JSON.parse(gunzipSync(Buffer.from(owner.names, "base64")).toString("utf8"));
      names.push(names[0]); owner.names = gzipSync(Buffer.from(JSON.stringify(names))).toString("base64"); owner.files = names.length;
    }
    if (failure === "count") owner.files += 1;
    if (failure === "extra") value.write("node_modules/prisma/unknown-auth-state.json", "never open an unknown extra body\n");
    if (failure === "mode") chmodSync(join(value.worktree, "node_modules/prisma/index.js"), 0o755);
    if (failure === "link") { rmSync(join(value.worktree, "node_modules/prisma/index.js")); symlinkSync(value.worktree, join(value.worktree, "node_modules/prisma/index.js")); }
    state.inputs.inputSha256 = originIdentity(state.inputs.trackedInputSha256, state.inputs.files, state.inputs.packages);
    writeFileSync(file, JSON.stringify(state));
    const before = readFileSync(file);
    const publisher = value.start("redeploy");
    try {
      const result = invokeSync(value, "prepare", publisher.context);
      expect(result.status, result.stdout).toBe(1);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(readFileSync(file)).toEqual(before);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
    } finally { publisher.finish(); }
  }, 30000);

  it.each(["edited", "extra", "untracked-input", "symlink"] as const)(
    "rejects %s generated input before validation and preserves the retained feature artifacts", (failure) => {
    const value = setup();
    const generated = prismaInputFixture(value);
    if (failure === "edited") value.write(generated.output, "throw new Error('poisoned cached output');\n");
    if (failure === "extra") value.write("packages/database/generated/unknown.ts", "export const poison = true;\n");
    if (failure === "untracked-input") value.write("packages/database/prisma/uncommitted.prisma", "// uncommitted collector input\n");
    if (failure === "symlink") symlinkSync(value.worktree, join(value.worktree, "packages/database/generated/alias"));
    const before = readFileSync(join(value.worktree, generated.output));
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(1);
      expect(result.json?.status).toBe("NEEDS_CHANGE");
      expect(readFileSync(join(value.worktree, generated.output))).toEqual(before);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it("consumes verified complete origin through prepare, source validation and exact publication", () => {
    const value = setup();
    prismaInputFixture(value);
    const source = value.sourceTurn();
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); } finally { source.finish(); }
    expect(validateFixture(value).status).toBe(0);
    const publish = value.start("redeploy");
    try {
      const pushed = invokeSync(value, "push", publish.context);
      expect(pushed.status, pushed.stdout).toBe(0);
      expect(invokeSync(value, "request", publish.context).status).toBe(0);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(true);
    } finally { publish.finish(); }
  }, 30000);

  it.each(["generated-byte", "extra-output", "untracked-collector", "producer-version", "producer-module", "source-owner", "execution-log"] as const)(
    "rejects %s origin drift at the actual prepare consumer before fetch or request", (failure) => {
    const value = setup();
    const generated = prismaInputFixture(value);
    const source = value.sourceTurn();
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); } finally { source.finish(); }
    const stateFile = join(value.metadata, "vibe-main-sync.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (failure === "generated-byte") value.write(generated.output, "throw new Error('after-origin poison');\n");
    if (failure === "extra-output") value.write("packages/database/generated/later.ts", "export const extra = 1;\n");
    if (failure === "untracked-collector") value.write("packages/database/prisma/later.prisma", "// later collector input\n");
    if (failure === "producer-version") value.write("node_modules/prisma/package.json", JSON.stringify({ name: "prisma", version: "7.11.0" }));
    if (failure === "producer-module") value.write("node_modules/prisma/index.js", "throw new Error('changed installed owner');\n");
    if (failure === "source-owner") {
      state.inputs.source.workerId = "different-source";
      writeFileSync(stateFile, JSON.stringify(state));
    }
    if (failure === "execution-log") writeFileSync(state.inputs.producers[0].log, "unverified execution\n");
    const retained = readFileSync(join(value.worktree, generated.output));
    const prepare = value.start("redeploy");
    try {
      const result = invokeSync(value, "prepare", prepare.context);
      expect(result.status, result.stdout).toBe(1);
      expect(result.json?.status).toBe("NEEDS_CHANGE");
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
      expect(readFileSync(join(value.worktree, generated.output))).toEqual(retained);
    } finally { prepare.finish(); }
  }, 30000);

  it("uses the trusted complete Fumadocs write before admitting warm noncanonical output bodies", () => {
    const value = setup();
    const generated = fumadocsInputFixture(value);
    value.write(generated.paths[0]!, "throw new Error('warm output must be replaced before consumption');\n");
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(result.json?.mainSync).toMatchObject({ generatedFiles: 4 });
      for (const path of generated.paths) expect(readFileSync(join(value.worktree, path), "utf8")).toBe(generated.body);
    } finally { source.finish(); }
  }, 30000);

  it("rejects an unknown later producer output before any feature full-write owner runs", () => {
    const value = setup();
    const generated = fumadocsInputFixture(value);
    value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\napps/desktop/src/shared/build-info.ts/\n`);
    const owner = buildInfoInputFixture(value);
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\npnpm --dir apps/web exec fumadocs-mdx\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Synthetic second canonical producer"]);
    rmSync(join(value.worktree, owner.output));
    value.write(`${owner.output}/unknown.ts`, "throw new Error('unknown output');\n");
    const warm = "throw new Error('must be preserved until every output set is known');\n";
    value.write(generated.paths[0]!, warm);
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/unknown generated/i);
      expect(readFileSync(join(value.worktree, generated.paths[0]!), "utf8")).toBe(warm);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it("reuses the actual import-safe current-context build-info renderer without requiring a generated scratch body", () => {
    const value = setup();
    const generated = buildInfoInputFixture(value);
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(result.json?.mainSync).toMatchObject({ generatedFiles: 1 });
      expect(readFileSync(join(value.worktree, generated.output), "utf8")).toBe(generated.body);
    } finally { source.finish(); }
  }, 30000);

  it.each(["migrations", "auth"] as const)("executes the actual import-safe %s pure API and binds its complete body", (kind) => {
    const value = setup();
    const generated = pureInputFixture(value, kind);
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(readFileSync(join(value.worktree, generated.output), "utf8")).toBe(generated.body);
      expect(existsSync(join(value.metadata, "FETCH_HEAD"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it("runs the actual docs producer against committed content without a Fumadocs prerequisite", () => {
    const value = setup();
    const generated = docsInputFixture(value);
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(readFileSync(join(value.worktree, generated.output), "utf8")).toBe(generated.body);
      expect(existsSync(join(value.worktree, "apps/web/.source"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it("verifies locked support through its literal without importing the throwing installer", () => {
    const value = setup();
    const generated = huskyInputFixture(value);
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      expect(readFileSync(join(value.worktree, generated.output), "utf8")).toBe(generated.body);
    } finally { source.finish(); }
  }, 30000);

  it.each([false, true])("compares Desktop client bytes separately from its current fingerprint (poison=%s)", (poison) => {
    const value = setup();
    const generated = desktopPrismaInputFixture(value);
    if (poison) value.write(generated.output, "throw new Error('poisoned client with current marker');\n");
    const before = readFileSync(join(value.worktree, generated.output));
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(poison ? 1 : 0);
      expect(readFileSync(join(value.worktree, generated.output))).toEqual(before);
      expect(readFileSync(join(value.worktree, generated.fingerprint), "utf8")).toBe("current input fingerprint");
      if (poison) expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
    } finally { source.finish(); }
  }, 30000);

  it("rejects tracked Next config rewriting in pristine generation before consuming any feature output", () => {
    const value = setup();
    nextInputFixture(value);
    const before = readFileSync(join(value.worktree, "apps/api/next-env.d.ts"));
    const pnpm = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", pnpm.replace("const run=require('node:child_process').spawnSync(process.execPath,['scripts/fixture-next.cjs'", "fs.writeFileSync(path.join(process.cwd(),'apps/api/tsconfig.json'),'{}\\n');const run=require('node:child_process').spawnSync(process.execPath,['scripts/fixture-next.cjs'"));
    const source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(1);
      expect(String(result.json?.error)).toMatch(/tracked|committed validation inputs/i);
      expect(readFileSync(join(value.worktree, "apps/api/next-env.d.ts"))).toEqual(before);
      expect(existsSync(join(value.metadata, "vibe-main-sync.json"))).toBe(false);
      expect(readFileSync(join(value.worktree, "apps/api/tsconfig.json"), "utf8")).toContain("include");
    } finally { source.finish(); }
  }, 30000);

  it.each(["direct", "affected"] as const)("re-verifies %s selected full-write output and restarts checks before certifying the new immutable input", (kind) => {
    const value = setup();
    const generated = fumadocsInputFixture(value);
    value.write("apps/web/package.json", JSON.stringify({ name: "web", dependencies: { "fumadocs-mdx": "14.3.1" },
      scripts: { typecheck: "fumadocs-mdx && tsc --noEmit" } }));
    value.git(["add", "apps/web/package.json"]); value.git(["commit", "-m", "Synthetic selected full-write typecheck"]);
    const pnpm = readFileSync(join(value.bin, "pnpm"), "utf8").replace("package: 'app'", "package: 'web'");
    value.write("../bin/pnpm", pnpm.replace("const command = args[0];", `
if(${kind === "direct" ? "args[0]==='turbo'&&args[1]==='typecheck'" : "args[0]==='typecheck:affected'"}&&!args.includes('--dry=json')&&!fs.existsSync(path.join(process.cwd(),'.git','fixture-generated-once'))) {
  fs.writeFileSync(path.join(process.cwd(),'.git','fixture-generated-once'),'one canonical selected change');
  fs.writeFileSync(${JSON.stringify(generated.paths[0])},'export const checkProducedDocs = true;\\n');
}
const command = args[0];`));
    const source = value.sourceTurn();
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); } finally { source.finish(); }
    const result = validateFixture(value);
    expect(result.status, result.stdout).toBe(0);
    for (const path of generated.paths) expect(readFileSync(join(value.worktree, path), "utf8")).toBe(generated.body);
    const calls = value.calls().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[0] === "check:source-gates")).toHaveLength(2);
  }, 60000);
  it.each(["selected", "unselected", "second-drift"] as const)("handles %s Next recovery without invoking an unselected Fuma feature writer", (kind) => {
    const value = setup();
    const docs = fumadocsInputFixture(value);
    nextInputFixture(value);
    if (kind === "second-drift") value.write("apps/web/package.json", JSON.stringify({ name: "web", dependencies: { "fumadocs-mdx": "14.3.1" }, scripts: { typecheck: "fumadocs-mdx && tsc --noEmit" } }));
    value.write("apps/api/package.json", JSON.stringify({ name: "api", dependencies: { next: "16.3.6" }, scripts: { typecheck: "next typegen && tsc --noEmit" } }));
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-next.cjs setup\npnpm --dir apps/web exec fumadocs-mdx\n");
    value.git(["add", "apps/api/package.json", "apps/web/package.json"]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
    value.git(["commit", "-m", "Synthetic two-owner recovery"]);
    let pnpm = readFileSync(join(value.bin, "pnpm"), "utf8").replace("package: 'app'", `package: '${kind === "unselected" ? "web" : "api"}'`);
    if (kind === "second-drift") pnpm = pnpm.replace("if (args.includes('--dry=json')) {", "if(args.includes('--dry=json')) {process.stdout.write(JSON.stringify({tasks:[{taskId:'api#typecheck',package:'api'},{taskId:'web#typecheck',package:'web'}]}));process.exit(0);}\nif (args.includes('--dry=json')) {");
    const marker = join(value.bin, "next-variant");
    value.write("../bin/pnpm", pnpm.replace("['scripts/fixture-next.cjs',args[1].split('/')[1]],{cwd:process.cwd(),encoding:'utf8'});",
      `['scripts/fixture-next.cjs',args[1].split('/')[1]],{cwd:process.cwd(),encoding:'utf8'});if(args[1]==='apps/api'&&fs.existsSync(${JSON.stringify(marker)}))fs.writeFileSync('apps/api/next-env.d.ts','export const selectedVariant = true;\\n');`)
      .replace("const command = args[0];", `
if(args[0]==='typecheck:affected'&&!fs.existsSync(${JSON.stringify(marker)})) {
 fs.writeFileSync(${JSON.stringify(marker)},'new canonical variant');fs.writeFileSync('apps/api/next-env.d.ts','export const selectedVariant = true;\\n');
}
${kind === "second-drift" ? `else if(args[0]==='typecheck:affected')fs.writeFileSync(${JSON.stringify(docs.paths[0])},'export const distinctSecondDrift = true;\\n');` : ""}
const command = args[0];`));
    const source = value.sourceTurn();
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); } finally { source.finish(); }
    const before = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).inputs;
    const baseline = value.calls().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    const publisher = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    const validation = value.sourceTurn();
    try {
      const result = invokeSync(value, "validate", validation.context);
      expect(result.status, result.stdout).toBe(kind === "selected" ? 0 : 1);
      if (kind !== "selected") expect(result.json?.status).toBe("NEEDS_CHANGE");
    } finally { validation.finish(); }
    const after = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).inputs;
    const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    if (kind !== "selected") expect(receipt.validation).toBeUndefined();
    expect(receipt.pushedHead).toBeUndefined();
    expect(after.producers.find((item: { id: string }) => item.id === "fumadocs")).toEqual(before.producers.find((item: { id: string }) => item.id === "fumadocs"));
    const calls = value.calls().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    const fuma = (args: string[]) => args.join(" ") === "--dir apps/web exec fumadocs-mdx";
    expect(calls.filter(fuma)).toHaveLength(baseline.filter(fuma).length);
    for (const path of docs.paths) expect(readFileSync(join(value.worktree, path), "utf8")).toBe(kind === "second-drift" && path === docs.paths[0]
      ? "export const distinctSecondDrift = true;\n" : docs.body);
  }, 60000);

  it("stores the selected one-recovery lifecycle reserve in the canonical post-merge recipe", () => {
    const value = setup();
    fumadocsInputFixture(value);
    value.write("apps/web/package.json", JSON.stringify({ name: "web", dependencies: { "fumadocs-mdx": "14.3.1" }, scripts: { typecheck: "fumadocs-mdx && tsc --noEmit" } }));
    value.git(["add", "apps/web/package.json"]); value.git(["commit", "-m", "Synthetic recovery budget owner"]);
    value.write("../bin/pnpm", readFileSync(join(value.bin, "pnpm"), "utf8").replace("package: 'app'", "package: 'web'"));
    let source = value.sourceTurn();
    try { expect(invokeSync(value, "inputs", source.context).status).toBe(0); } finally { source.finish(); }
    const publisher = value.start("redeploy");
    try { expect(invokeSync(value, "prepare", publisher.context).status).toBe(0); } finally { publisher.finish(); }
    source = value.sourceTurn();
    try {
      const result = invokeSync(value, "inputs", source.context);
      expect(result.status, result.stdout).toBe(0);
      const state = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
      expect(state.previous.recipe.recovery).toEqual({ owners: ["fumadocs"], timeoutMs: 5 * 15 * 60 * 1000 });
    } finally { source.finish(); }
  }, 60000);
});
