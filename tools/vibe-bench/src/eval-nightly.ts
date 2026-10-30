import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOwnedProcess } from "./owned-process.ts";

const NIGHTLY_DEADLINE_MS = 3 * 60 * 60_000;

/** Injectable scheduler boundary used by deterministic T0 tests. */
export interface EvalNightlyCommands {
  git(repo: string, args: string[]): string;
  node(args: string[], signal?: AbortSignal): Promise<string> | string;
  now(): Date;
}

class SystemNightlyCommands implements EvalNightlyCommands {
  git(repo: string, args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"], timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }).trim();
  }
  async node(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await runOwnedProcess(process.execPath, args, {
      cwd: process.cwd(), deadline: Date.now() + NIGHTLY_DEADLINE_MS, signal,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.exitCode !== 0) throw new Error("eval-nightly-child-failed");
    return result.stdout.trim();
  }
  now(): Date { return new Date(); }
}

/** Run T2 from a dedicated clean main checkout for a local machine scheduler. */
export async function main(args: string[],
  commands: EvalNightlyCommands = new SystemNightlyCommands()): Promise<string> {
  if (args.length !== 7) {
    throw new Error("usage: eval-nightly.ts <clean-main-checkout> <run-root-parent> <output-dir> <claude> <codex> <uv> <gh>");
  }
  const [repo, runRootParent, outputDir, claude, codex, uv, gh] = args;
  const git = (...gitArgs: string[]) => commands.git(repo, gitArgs);
  if (git("status", "--porcelain") || git("branch", "--show-current") !== "main") {
    throw new Error("eval-nightly-main-checkout-not-clean");
  }
  git("fetch", "origin", "main");
  git("merge", "--ff-only", "origin/main");
  const sha = git("rev-parse", "HEAD^{commit}");
  const stamp = commands.now().toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "");
  const runRoot = join(runRootParent, `t2-${stamp}-${sha.slice(0, 12)}`);
  if (existsSync(runRoot)) throw new Error("eval-nightly-run-root-exists");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return (await commands.node(["--experimental-strip-types", cli, "eval-t2",
      repo, sha, runRoot, outputDir, claude, codex, uv, gh], abort.signal)).trim();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (output) => process.stdout.write(`${output}\n`),
    (error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; },
  );
}
