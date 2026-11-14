import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEPT_SANDBOX_LINE_PREFIX, SlackNightlyRegressionReporter } from "./eval-slack.ts";
import { runOwnedProcess } from "./owned-process.ts";

const NIGHTLY_DEADLINE_MS = 3 * 60 * 60_000;

/** Injectable scheduler boundary used by deterministic T0 tests. */
export interface EvalNightlyCommands {
  git(repo: string, args: string[]): string;
  node(args: string[], signal?: AbortSignal): Promise<string> | string;
  now(): Date;
}

/** The real scheduler boundary: git on the clean checkout and one owned child process. */
export class SystemNightlyCommands implements EvalNightlyCommands {
  private readonly writeOutput: (text: string) => unknown;
  constructor(writeOutput: (text: string) => unknown = (text) => process.stdout.write(text)) {
    this.writeOutput = writeOutput;
  }
  git(repo: string, args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"], timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }).trim();
  }
  async node(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await runOwnedProcess(process.execPath, args, {
      cwd: process.cwd(), deadline: Date.now() + NIGHTLY_DEADLINE_MS, signal,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      // A failed child's stdout is dropped, yet its kept-sandbox lines belong
      // in the machine log. They stay on stdout: on stderr a claude-eval-<id>
      // path would be read as the failure reason below.
      for (const line of result.stdout.split(/\r?\n/)) {
        if (line.startsWith(KEPT_SANDBOX_LINE_PREFIX)) this.writeOutput(`${line}\n`);
      }
      const reason = result.stderr.match(/(?:eval|benchmark)-[a-z0-9:-]+/)?.[0] ??
        "eval-nightly-child-failed";
      throw new Error(reason);
    }
    return result.stdout.trim();
  }
  now(): Date { return new Date(); }
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error).trim() || "eval-nightly-unknown-failure";
}

/** Log and report one scheduler infrastructure failure without hiding the original error. */
export async function reportNightlyInfrastructureFailure(reason: string,
  reporter: Pick<SlackNightlyRegressionReporter, "reportInfrastructure"> =
    new SlackNightlyRegressionReporter(),
  writeError: (message: string) => unknown = (message) => process.stderr.write(message),
  writeOutput: (message: string) => unknown = (message) => process.stdout.write(message),
): Promise<void> {
  writeError(`VIBE_NIGHTLY_INFRA_FAILURE ${reason}\n`);
  try {
    await reporter.reportInfrastructure({ reason, occurredAt: new Date().toISOString() });
    writeOutput("VIBE_NIGHTLY_SLACK_POSTED\n");
  } catch (error) {
    writeError(`VIBE_NIGHTLY_SLACK_FAILURE ${errorReason(error)}\n`);
  }
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

/**
 * Publish a finished nightly and print its output once. The kept-sandbox lines
 * are printed before publishing, so a failed publish still leaves them in the log.
 */
export async function finishNightly(output: string, args: string[], runAt: string,
  publish: (output: string, args: string[], runAt: string) => Promise<string> = publishCompletedNightly,
  writeOutput: (text: string) => unknown = (text) => process.stdout.write(text)): Promise<void> {
  const lines = output.split(/\r?\n/);
  for (const line of lines.filter((item) => item.startsWith(KEPT_SANDBOX_LINE_PREFIX))) {
    writeOutput(`${line}\n`);
  }
  const publication = await publish(output, args, runAt);
  const rest = lines.filter((item) => !item.startsWith(KEPT_SANDBOX_LINE_PREFIX)).join("\n");
  writeOutput(`${publication}\n${rest}\n`);
}

/** Use a newly loaded child after fast-forward; SKIPPED only recovers prior durable RAN work. */
export async function publishCompletedNightly(output: string, args: string[], runAt: string,
  invoke: (args: string[]) => Promise<string> = (command) =>
    new SystemNightlyCommands().node(command)): Promise<string> {
  if (args.length !== 7) throw new Error("eval-publish-nightly-args-invalid");
  const skipped = output.split(/\r?\n/).some((line) => line.startsWith("SKIPPED "));
  const path = skipped ? "RECOVER" : output.trim().split(/\r?\n/).at(-1);
  if (!path || (path !== "RECOVER" && (!isAbsolute(path) ||
      !/^eval-t2-[a-zA-Z0-9.-]+\.json$/.test(path.split("/").at(-1)!)))) {
    throw new Error("eval-publish-nightly-result-missing");
  }
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  try {
    return await invoke(["--experimental-strip-types", cli, "eval-publish", args[0]!, args[1]!,
      args[2]!, path, runAt, args[5]!, args[6]!]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new Error(/^eval-publish-[a-z0-9-]+$/.test(message)
      ? message : "eval-publish-input-invalid");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const runAt = new Date().toISOString();
  if (args[0] === "--notify-infra" && args.length === 3) {
    new SlackNightlyRegressionReporter(args[1]).reportInfrastructure({
      reason: args[2], occurredAt: new Date().toISOString(),
    }).then(() => process.stdout.write("VIBE_NIGHTLY_SLACK_POSTED\n")).catch((error) => {
      process.stderr.write(`VIBE_NIGHTLY_SLACK_FAILURE ${errorReason(error)}\n`);
      process.exitCode = 1;
    });
  } else {
    main(args).then(
      async (output) => { await finishNightly(output, args, runAt); },
      async (error) => {
        const claude = args.length === 7 ? args[3] : "claude";
        await reportNightlyInfrastructureFailure(errorReason(error),
          new SlackNightlyRegressionReporter(claude));
        process.exitCode = 1;
      },
    ).catch(async (error) => {
      await reportNightlyInfrastructureFailure(errorReason(error),
        new SlackNightlyRegressionReporter(args[3] ?? "claude"));
      process.exitCode = 1;
    });
  }
}
