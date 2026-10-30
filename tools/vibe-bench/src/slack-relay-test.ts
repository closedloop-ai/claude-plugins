import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SlackNightlyRegressionReporter } from "./eval-slack.ts";
import type { SlackDeliveryReceipt } from "./eval-slack.ts";

const ATTEMPT_MARKER = join(homedir(), ".config", "vibe-eval-nightly",
  "iss-13478-slack-test.attempted");

interface ApprovedSlackTestReporter {
  reportApprovedTest(): Promise<SlackDeliveryReceipt>;
}

interface ApprovedSlackTestDependencies {
  claimAttempt?(): void;
  reporter?(claudeExecutable: string): ApprovedSlackTestReporter;
}

export interface ApprovedSlackTestResult {
  exitCode: number;
  line: string;
}

function claimApprovedAttempt(): void {
  mkdirSync(dirname(ATTEMPT_MARKER), { recursive: true, mode: 0o700 });
  let marker: number;
  try { marker = openSync(ATTEMPT_MARKER, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("eval-slack-approved-test-already-attempted");
    }
    throw error;
  }
  try { writeFileSync(marker, `${new Date().toISOString()}\n`); }
  finally { closeSync(marker); }
}

/** Run only the fixed ISS-13478 Slack relay test, guarded against a second attempt. */
export async function runApprovedSlackTest(args: string[],
  dependencies: ApprovedSlackTestDependencies = {}): Promise<ApprovedSlackTestResult> {
  if (args.length !== 1 || !args[0]) {
    return { exitCode: 64, line: "VIBE_NIGHTLY_SLACK_TEST " + JSON.stringify({
      result: "FAILED", identity: null,
      error: "usage: slack-relay-test.ts <absolute-claude-executable>",
    }) };
  }
  try {
    (dependencies.claimAttempt ?? claimApprovedAttempt)();
    const reporter = dependencies.reporter?.(args[0]) ??
      new SlackNightlyRegressionReporter(args[0]);
    const receipt = await reporter.reportApprovedTest();
    return { exitCode: 0, line: "VIBE_NIGHTLY_SLACK_TEST " + JSON.stringify({
      result: "POSTED", ...receipt,
    }) };
  } catch (error) {
    return { exitCode: 1, line: "VIBE_NIGHTLY_SLACK_TEST " + JSON.stringify({
      result: "FAILED", identity: null,
      error: error instanceof Error ? error.message : String(error),
    }) };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runApprovedSlackTest(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${result.line}\n`);
    process.exitCode = result.exitCode;
  });
}
