import { MainSyncError } from "./main-sync-contracts.js";
import type { CheckCommand } from "./main-sync-lanes.js";
import { rejectReportReplay, reportExecutionSchema, type ReportExecutionOwner as ExecutionOwner } from "./main-sync-report-execution.js";
import { reportCommandEntries } from "./main-sync-report-command.js";
import { verifyReportClosure } from "./main-sync-report-closure.js";
import { committedIdentity } from "./main-sync-state.js";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";

/** Actual structured recipe argv is checked again; caller text cannot authorize replay or retained-result verdicts. */
export function verifyReportRecipe(commands: readonly CheckCommand[]) {
  for (const command of commands) {
    rejectReportReplay(command.argv.join(" "));
  }
}

/** Existing owners derive this scope before their actual child; no stdin/task field can supply it. */
export function verifyReportExecution(retainedRoot: string, root: string, owner: ExecutionOwner, argv: readonly string[], cwd = root,
  selection?: { tasks: { taskId: string; package?: string }[] }) {
  const identity = committedIdentity(root);
  const execution = reportExecutionSchema.parse({ root, retainedRoot, owner, argv: [...argv], cwd,
    headSha: identity.headSha, treeSha: identity.treeSha, ...(selection ? { tasks: selection.tasks } : {}) });
  rejectReportReplay(execution.argv.join(" "));
  const entries = reportCommandEntries(execution);
  verifyReportClosure(execution, entries);
  const after = committedIdentity(root);
  if (after.headSha !== execution.headSha || after.treeSha !== execution.treeSha) {
    throw new MainSyncError("Selected report execution source changed during assessment", "NEEDS_CHANGE");
  }
}

/** Declared producer source inputs remain independent of a bootstrap/health purpose. */
export function verifyReportProducerInputs(retainedRoot: string, root: string, owner: ExecutionOwner, inputs: readonly string[]) {
  const identity = committedIdentity(root);
  const files = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", ...inputs]).split("\n")
    .filter(file => /\.[cm]?[jt]sx?$/.test(file));
  const execution = reportExecutionSchema.parse({ root, retainedRoot, owner, argv: ["declared-producer-inputs"], cwd: root,
    headSha: identity.headSha, treeSha: identity.treeSha });
  verifyReportClosure(execution, files.map(file => ({ file, context: { kind: "known" as const, path: root }, argv: [] })));
  const after = committedIdentity(root);
  if (after.headSha !== identity.headSha || after.treeSha !== identity.treeSha) {
    throw new MainSyncError("Declared producer inputs changed during report assessment", "NEEDS_CHANGE");
  }
}
