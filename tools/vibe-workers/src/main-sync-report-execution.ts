import { z } from "zod";
import { MainSyncError } from "./main-sync-contracts.js";

const REPLAY = /(?:^|[\s=])--(?:merge-reports|last-failed)(?:\b|=)|(?:^|[\s/])assert-e2e-results(?:\.mjs)?\b/;

/** These are existing execution owners, not caller-selectable runtime capabilities. */
export const ReportExecutionOwner = {
  Bootstrap: "origin-bootstrap",
  Producer: "origin-producer",
  Pure: "origin-pure",
  Discovery: "lane-discovery",
  AffectedFilter: "affected-filter",
  TurboSelection: "turbo-selection",
  Check: "fixed-check",
} as const;

export type ReportExecutionOwner = (typeof ReportExecutionOwner)[keyof typeof ReportExecutionOwner];

export const reportExecutionSchema = z.object({
  root: z.string().min(1),
  retainedRoot: z.string().min(1),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40}$/),
  owner: z.nativeEnum(ReportExecutionOwner),
  cwd: z.string().min(1),
  argv: z.array(z.string()).min(1).max(128),
  bindings: z.record(z.string()).optional(),
  tasks: z.array(z.object({ taskId: z.string(), package: z.string().optional() }).passthrough()).max(50000).optional(),
}).strict();

export type ReportExecution = z.infer<typeof reportExecutionSchema>;

/** A health label cannot authorize a selected retained-result verdict or replay. */
export function rejectReportReplay(command: string) {
  if (REPLAY.test(command)) throw new MainSyncError("Selected recipe consumes retained report/replay inputs without current owned output isolation", "NEEDS_CHANGE");
}
