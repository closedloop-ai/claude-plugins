// The live steps of a replay. `createLiveDeps({sourceRepo, workRoot, testCommand, ...})`
// returns the `deps` that runner.mjs and scorer.mjs name; a module that exports its
// result as the default export is what `cli.mjs run|score --deps <module>` loads. Everything that touches a
// process is injectable so the wiring is tested without Claude or the product repo.
//
// `testCommand(file)` returns the `[command, ...args]` that runs one oracle test
// file; it is the product repo's own command, so it is the caller's to give.
// A test file's result is that command's exit code, run once per file.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { contaminationMentions, runClaudeArm } from "./claude-arm.mjs";
import { copyForRun, prepareClone } from "./workspace.mjs";

export function createLiveDeps({ sourceRepo, workRoot, testCommand, run = spawnSync, runClaude = runClaudeArm, runOptions = {} }) {
  const prepared = new Map();
  const dirs = (ticket) => ({ clone: path.join(workRoot, ticket.slug, "clone"), oracle: path.join(workRoot, ticket.slug, "oracle") });
  return {
    prepareWorkspace({ ticket, arm, run: n }) {
      const { clone, oracle } = dirs(ticket);
      if (!prepared.has(ticket.slug)) {
        prepareClone({ sourceRepo, ticket, workspace: clone, oracleDir: oracle });
        prepared.set(ticket.slug, clone);
      }
      return { workspace: copyForRun({ prepared: clone, dest: path.join(workRoot, ticket.slug, `${arm.name}-${n}`) }) };
    },
    async runArm({ arm, brief, workspace, run: n, ticket }) {
      const outDir = path.join(workRoot, ticket.slug, `${arm.name}-${n}-out`);
      const output = runClaude({ arm, brief, workspace, outDir, ...runOptions });
      return { ...output, contamination: contaminationMentions(output.outputText, { slug: ticket.slug, prNumber: ticket.pr.number, mergeSha: ticket.pr.mergeSha }) };
    },
    captureDiff({ workspace, baseSha }) {
      const git = (...args) => run("git", ["-C", workspace, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      git("add", "-A");
      return { numstat: git("diff", "--cached", "--numstat", baseSha).stdout ?? "", diffText: git("diff", "--cached", baseSha).stdout ?? "" };
    },
    /** Puts the human version of each oracle test file in the tree, then runs the product's command once per file. */
    runTests({ workspace, testFiles, ticket }) {
      const { oracle: oracleDir } = dirs(ticket);
      return testFiles.map((file) => {
        mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
        copyFileSync(path.join(oracleDir, "files", file), path.join(workspace, file));
        const [command, ...args] = testCommand(file);
        const outcome = run(command, args, { cwd: workspace, encoding: "utf8", timeout: runOptions.testTimeoutMs ?? 20 * 60 * 1000 });
        return { path: file, exitCode: Number.isInteger(outcome.status) ? outcome.status : null };
      });
    },
  };
}
