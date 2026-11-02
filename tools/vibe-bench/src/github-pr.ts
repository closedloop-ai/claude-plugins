import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceBenchmarkPr, benchmarkPr, BENCHMARK_TASK } from "./contract.ts";
import type { BenchmarkPr } from "./contract.ts";
import type { PreparedFixture } from "./fixture.ts";

/** Explicit proof destination; the Claude checkout's origin always stays fake. */
export const PROOF_REPO = "closedloop-ai/symphony-alpha";
export const PROOF_REMOTE = "git@github.com:closedloop-ai/symphony-alpha.git";
export const PROOF_LIFECYCLE_FILE = "benchmark-proof-lifecycle.json";

/** Minimal command boundary so PR lifecycle tests cannot reach GitHub. */
export interface PrCommands {
  run(command: string, args: string[], cwd: string): string;
}

/** Process-backed command adapter; all arguments are passed without a shell. */
export class ProcessPrCommands implements PrCommands {
  run(command: string, args: string[], cwd: string): string {
    return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 90_000 }).trim();
  }
}

/** Run-owned GitHub proof and its record-before-close state. */
export interface PublishedProof {
  baseRef: string;
  ref: string;
  number: number;
  url: string;
  pr: BenchmarkPr;
  recordedHash: string | null;
  baseRefPushed: boolean;
  refPushed: boolean;
  closed: boolean;
  headRefRemoved: boolean;
  baseRefRemoved: boolean;
  refRemoved: boolean;
  journalFile: string;
  cwd: string;
}

/** Durable state that lets the parent clean up after killing a run child. */
export interface ProofLifecycleRecord {
  schemaVersion: 1;
  cwd: string;
  baseRef: string;
  ref: string;
  number: number;
  baseRefPushed: boolean;
  refPushed: boolean;
  closed: boolean;
  headRefRemoved: boolean;
  baseRefRemoved: boolean;
}

/** Deterministic proof refs known to the parent before the run child starts. */
export function proofRefs(sourceSha: string, runKey: string): { baseRef: string; ref: string } {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-z0-9-]{6,36}$/.test(runKey)) {
    throw new Error("benchmark-proof-ref-input-invalid");
  }
  const prefix = `proof/${sourceSha.slice(0, 12)}-iss13401-${runKey}`;
  return { baseRef: `${prefix}-base`, ref: `${prefix}-head` };
}

function lifecycleRecord(proof: PublishedProof): ProofLifecycleRecord {
  return { schemaVersion: 1, cwd: proof.cwd, baseRef: proof.baseRef, ref: proof.ref,
    number: proof.number, baseRefPushed: proof.baseRefPushed, refPushed: proof.refPushed,
    closed: proof.closed, headRefRemoved: proof.headRefRemoved,
    baseRefRemoved: proof.baseRefRemoved };
}

function persistLifecycle(proof: PublishedProof): void {
  const temporary = `${proof.journalFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(lifecycleRecord(proof), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, proof.journalFile);
}

function parseLifecycle(runDir: string, expectedBaseRef: string,
  expectedRef: string): ProofLifecycleRecord | null {
  const file = join(runDir, PROOF_LIFECYCLE_FILE);
  if (!existsSync(file)) return null;
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error("benchmark-proof-lifecycle-invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("benchmark-proof-lifecycle-invalid");
  }
  const record = value as Partial<ProofLifecycleRecord>;
  const expectedCwd = realpathSync(join(runDir, "agent"));
  if (record.schemaVersion !== 1 || record.cwd !== expectedCwd ||
      record.baseRef !== expectedBaseRef || record.ref !== expectedRef ||
      !Number.isInteger(record.number) || (record.number ?? -1) < 0 ||
      [record.baseRefPushed, record.refPushed, record.closed, record.headRefRemoved,
        record.baseRefRemoved].some((item) => typeof item !== "boolean")) {
    throw new Error("benchmark-proof-lifecycle-invalid");
  }
  return record as ProofLifecycleRecord;
}

function persistRecord(runDir: string, record: ProofLifecycleRecord): void {
  const file = join(runDir, PROOF_LIFECYCLE_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Close and delete proof state recorded by a child, including a PR discovered by its head ref. */
export function cleanupRecordedProof(runDir: string, expectedBaseRef: string, expectedRef: string,
  commands: PrCommands, gh: string): string[] {
  const record = parseLifecycle(runDir, expectedBaseRef, expectedRef);
  if (!record) return [];
  const failures: string[] = [];
  const present = new Map<"head" | "base", boolean>();
  for (const [key, ref] of [["head", record.ref], ["base", record.baseRef]] as const) {
    try {
      present.set(key, Boolean(commands.run("git", ["ls-remote", "--heads", PROOF_REMOTE, ref], record.cwd)));
    } catch (error) {
      failures.push(`${key}-probe:${String(error)}`);
    }
  }
  if (record.number === 0) {
    try {
      const rows = JSON.parse(commands.run(gh, ["pr", "list", "--repo", PROOF_REPO,
        "--state", "all", "--head", record.ref, "--json", "number"], record.cwd)) as Array<{ number?: number }>;
      if (rows.length > 1 || (rows.length === 1 && !Number.isInteger(rows[0].number))) {
        throw new Error("benchmark-proof-pr-recovery-invalid");
      }
      if (rows.length === 1) record.number = rows[0].number!;
      persistRecord(runDir, record);
    } catch (error) { failures.push(`recover:${String(error)}`); }
  }
  if (record.number > 0 && !record.closed) {
    try {
      const view = JSON.parse(commands.run(gh, ["pr", "view", String(record.number), "--repo", PROOF_REPO,
        "--json", "number,state,headRefName"], record.cwd)) as {
        number?: number; state?: string; headRefName?: string;
      };
      if (view.number !== record.number || view.headRefName !== record.ref ||
          (view.state !== "OPEN" && view.state !== "CLOSED")) {
        throw new Error("benchmark-proof-pr-recovery-mismatch");
      }
      if (view.state === "OPEN") {
        commands.run(gh, ["pr", "close", String(record.number), "--repo", PROOF_REPO], record.cwd);
      }
      const closed = JSON.parse(commands.run(gh, ["pr", "view", String(record.number), "--repo", PROOF_REPO,
        "--json", "number,state,headRefName"], record.cwd)) as {
        number?: number; state?: string; headRefName?: string;
      };
      if (closed.number !== record.number || closed.state !== "CLOSED" || closed.headRefName !== record.ref) {
        throw new Error("benchmark-pr-not-closed");
      }
      record.closed = true;
      persistRecord(runDir, record);
    } catch (error) { failures.push(`close:${String(error)}`); }
  }
  for (const [key, removed] of [
    ["head", record.headRefRemoved],
    ["base", record.baseRefRemoved],
  ] as const) {
    if (present.get(key) === undefined) continue;
    const ref = key === "head" ? record.ref : record.baseRef;
    try {
      if (present.get(key)) {
        commands.run("git", ["push", PROOF_REMOTE, `:refs/heads/${ref}`], record.cwd);
      }
      if (commands.run("git", ["ls-remote", "--heads", PROOF_REMOTE, ref], record.cwd)) {
        throw new Error("benchmark-proof-ref-not-removed");
      }
      if (!removed) {
        if (key === "head") record.headRefRemoved = true;
        else record.baseRefRemoved = true;
        persistRecord(runDir, record);
      }
    } catch (error) { failures.push(`${key}-ref:${String(error)}`); }
  }
  return failures;
}

function validPublicText(value: string): void {
  if (/\/(?:Users|private|tmp|var\/folders)\/|\b(?:laptop|localhost|local path)\b/i.test(value)) {
    throw new Error("benchmark-pr-private-wording");
  }
}

/** Publish, record, close and remove only a proof ref created by this adapter. */
export class GithubProofPr {
  private readonly commands: PrCommands;
  private readonly gh: string;

  constructor(commands: PrCommands, gh: string) {
    this.commands = commands;
    this.gh = gh;
  }

  /** Publish one verified task-only commit against run-owned proof refs. */
  publish(fixture: PreparedFixture, runDir: string, runKey: string): PublishedProof {
    if (!/^[a-z0-9-]{6,36}$/.test(runKey)) throw new Error("benchmark-proof-run-key-invalid");
    const cwd = fixture.agentCheckout;
    if (!/^[a-f0-9]{40}$/.test(fixture.sourceSha) || !/^[a-f0-9]{40}$/.test(fixture.baseSha)) {
      throw new Error("benchmark-proof-source-sha-invalid");
    }
    const changed = this.commands.run("git", ["diff", "--name-only", "HEAD"], cwd).split("\n").filter(Boolean);
    if (changed.length !== 1 || changed[0] !== BENCHMARK_TASK.file) throw new Error("benchmark-proof-task-scope-invalid");
    this.commands.run("git", ["add", "--", BENCHMARK_TASK.file], cwd);
    this.commands.run("git", ["-c", "user.name=vibe benchmark", "-c", "user.email=benchmark@invalid.local",
      "commit", "-m", "test(benchmark): repair Projects infix search"], cwd);
    const { baseRef, ref } = proofRefs(fixture.sourceSha, runKey);
    const pr = benchmarkPr(BENCHMARK_TASK.id);
    validPublicText(`${pr.title}\n${pr.body}`);
    const bodyFile = join(runDir, "benchmark-pr-body.md");
    writeFileSync(bodyFile, `${pr.body}\n`, { flag: "wx", mode: 0o600 });
    const proof: PublishedProof = { baseRef, ref, number: 0, url: "", pr, recordedHash: null,
      baseRefPushed: false, refPushed: false, closed: false,
      headRefRemoved: false, baseRefRemoved: false, refRemoved: false,
      journalFile: join(runDir, PROOF_LIFECYCLE_FILE), cwd };
    persistLifecycle(proof);
    try {
      if (this.commands.run("git", ["ls-remote", "--heads", PROOF_REMOTE, baseRef], cwd) ||
          this.commands.run("git", ["ls-remote", "--heads", PROOF_REMOTE, ref], cwd)) {
        throw new Error("benchmark-proof-ref-exists");
      }
      // The fake main has the seeded regression. A PR against real main would
      // have an empty final diff after repair, so publish a run-owned base ref.
      this.commands.run("git", ["push", PROOF_REMOTE, `${fixture.baseSha}:refs/heads/${baseRef}`], cwd);
      proof.baseRefPushed = true;
      persistLifecycle(proof);
      this.commands.run("git", ["push", PROOF_REMOTE, `HEAD:refs/heads/${ref}`], cwd);
      proof.refPushed = true;
      persistLifecycle(proof);
      const url = this.commands.run(this.gh, ["pr", "create", "--repo", PROOF_REPO, "--base", baseRef,
        "--head", ref, "--draft", "--title", pr.title, "--body-file", bodyFile], cwd);
      const match = url.match(/\/pull\/(\d+)\/?$/);
      if (!match) throw new Error("benchmark-pr-create-response-invalid");
      proof.number = Number(match[1]);
      proof.url = url;
      persistLifecycle(proof);
      const view = JSON.parse(this.commands.run(this.gh, ["pr", "view", String(proof.number), "--repo", PROOF_REPO,
        "--json", "number,isDraft,state,title,body,headRefName,baseRefName"], cwd)) as {
        number?: number; isDraft?: boolean; state?: string; title?: string; body?: string;
        headRefName?: string; baseRefName?: string;
      };
      if (view.number !== proof.number || view.isDraft !== true || view.state !== "OPEN" ||
          view.title !== pr.title || view.body?.trim() !== pr.body || view.headRefName !== ref ||
          view.baseRefName !== baseRef) throw new Error("benchmark-pr-published-contract-invalid");
      return proof;
    } catch (error) {
      if (proof.number === 0 && proof.refPushed) {
        try {
          const rows = JSON.parse(this.commands.run(this.gh, ["pr", "list", "--repo", PROOF_REPO,
            "--state", "all", "--head", proof.ref, "--json", "number"], cwd)) as Array<{ number?: number }>;
          if (rows.length === 1 && Number.isInteger(rows[0].number)) proof.number = rows[0].number!;
        } catch { /* preserve the original publish failure */ }
      }
      const cleanupFailures = this.cleanup(proof, cwd);
      throw new Error(`benchmark-pr-publish-failed:${String(error)}; cleanup=${cleanupFailures.join(",") || "complete"}`);
    }
  }

  /** Save an actual result digest in the draft before closing it. */
  record(proof: PublishedProof, resultHash: string, runDir: string, cwd: string): void {
    const recorded = advanceBenchmarkPr(proof.pr, "record", resultHash);
    const body = `${recorded.body}\nResult digest: ${resultHash}.\n`;
    validPublicText(body);
    const bodyFile = join(runDir, "benchmark-pr-recorded-body.md");
    writeFileSync(bodyFile, body, { flag: "wx", mode: 0o600 });
    this.commands.run(this.gh, ["pr", "edit", String(proof.number), "--repo", PROOF_REPO, "--body-file", bodyFile], cwd);
    writeFileSync(join(runDir, "benchmark-pr-record.json"), `${JSON.stringify({
      number: proof.number, ref: proof.ref, resultHash, recordedAt: new Date().toISOString(),
    })}\n`, { flag: "wx", mode: 0o600 });
    proof.pr = recorded;
    proof.recordedHash = resultHash;
    persistLifecycle(proof);
  }

  /** Close after recording, then remove exactly this run's proof ref. */
  close(proof: PublishedProof, cwd: string): void {
    proof.pr = advanceBenchmarkPr(proof.pr, "close");
    this.commands.run(this.gh, ["pr", "close", String(proof.number), "--repo", PROOF_REPO], cwd);
    const view = JSON.parse(this.commands.run(this.gh, ["pr", "view", String(proof.number), "--repo", PROOF_REPO,
      "--json", "number,state,headRefName"], cwd)) as { number?: number; state?: string; headRefName?: string };
    if (view.number !== proof.number || view.state !== "CLOSED" || view.headRefName !== proof.ref) {
      throw new Error("benchmark-pr-not-closed");
    }
    proof.closed = true;
    persistLifecycle(proof);
    this.commands.run("git", ["push", PROOF_REMOTE, `:refs/heads/${proof.ref}`], cwd);
    if (this.commands.run("git", ["ls-remote", "--heads", PROOF_REMOTE, proof.ref], cwd)) {
      throw new Error("benchmark-proof-ref-not-removed");
    }
    proof.headRefRemoved = true;
    persistLifecycle(proof);
    this.commands.run("git", ["push", PROOF_REMOTE, `:refs/heads/${proof.baseRef}`], cwd);
    if (this.commands.run("git", ["ls-remote", "--heads", PROOF_REMOTE, proof.baseRef], cwd)) {
      throw new Error("benchmark-proof-base-ref-not-removed");
    }
    proof.baseRefRemoved = true;
    proof.refRemoved = true;
    persistLifecycle(proof);
  }

  /** Best-effort emergency cleanup; callers must report any residual state. */
  cleanup(proof: PublishedProof, cwd: string): string[] {
    const failures: string[] = [];
    if (proof.number > 0 && !proof.closed) {
      try {
        this.commands.run(this.gh, ["pr", "close", String(proof.number), "--repo", PROOF_REPO], cwd);
        const view = JSON.parse(this.commands.run(this.gh, ["pr", "view", String(proof.number), "--repo", PROOF_REPO,
          "--json", "state,headRefName"], cwd)) as { state?: string; headRefName?: string };
        if (view.state !== "CLOSED" || view.headRefName !== proof.ref) throw new Error("benchmark-pr-not-closed");
        proof.closed = true;
        persistLifecycle(proof);
      } catch (error) { failures.push(`close:${String(error)}`); }
    }
    if (proof.refPushed && !proof.headRefRemoved) {
      try {
        this.commands.run("git", ["push", PROOF_REMOTE, `:refs/heads/${proof.ref}`], cwd);
        if (this.commands.run("git", ["ls-remote", "--heads", PROOF_REMOTE, proof.ref], cwd)) {
          throw new Error("benchmark-proof-ref-not-removed");
        }
        proof.headRefRemoved = true;
        persistLifecycle(proof);
      } catch (error) { failures.push(`ref:${String(error)}`); }
    }
    if (proof.baseRefPushed && !proof.baseRefRemoved) {
      try {
        this.commands.run("git", ["push", PROOF_REMOTE, `:refs/heads/${proof.baseRef}`], cwd);
        if (this.commands.run("git", ["ls-remote", "--heads", PROOF_REMOTE, proof.baseRef], cwd)) {
          throw new Error("benchmark-proof-base-ref-not-removed");
        }
        proof.baseRefRemoved = true;
        persistLifecycle(proof);
      } catch (error) { failures.push(`base-ref:${String(error)}`); }
    }
    proof.refRemoved = (!proof.refPushed || proof.headRefRemoved) &&
      (!proof.baseRefPushed || proof.baseRefRemoved);
    return failures;
  }
}
