import path from "node:path";
import { existsSync } from "node:fs";
import { absoluteGitDir } from "./session-record.mjs";
import { writeAtomic } from "./owned-state.mjs";
import { evidenceFingerprint, readEvidence } from "../../handoff/scripts/handoff-evidence.mjs";

/** A path-only critic deliverable delegates its content to precisely one bounded findings file. */
export function criticFindings(helper, lines) {
  if (helper.kind !== "critic" || helper.role !== "visual-qa-critic") return null;
  const names = lines.map(line => line.trim()).filter(Boolean);
  if (names.length !== 1 || !path.isAbsolute(names[0])) throw new Error("visual critic needs one absolute findings file");
  return evidenceFingerprint(names[0]);
}

function acceptanceFile(worktree, head) {
  if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error("critic findings need the complete source head");
  return path.join(absoluteGitDir(worktree), "vibe-accepted-visual-critic", head + ".json");
}

/** Persist the accepted report fingerprint privately so publication can recover it from the checkout. */
export function recordAcceptedCritic(worktree, head, report) {
  writeAtomic(acceptanceFile(worktree, head), report);
}

/** Authenticate the accepted report, then use its findings fingerprint on the consumer's actual read. */
export function acceptedCriticFindings(worktree, head) {
  if (!worktree) return undefined;
  const file = acceptanceFile(worktree, head);
  if (!existsSync(file)) return undefined;
  const report = JSON.parse(readEvidence(file).text);
  return reportFindings(report, head);
}

/** Recover the same accepted evidence from the fleet ledger when its checkout belongs to a remote machine. */
export function fleetCriticFindings(helpers, worktree, head) {
  if (!worktree) return undefined;
  const matches = Object.values(helpers).filter(helper => helper.acceptedAt && helper.role === "visual-qa-critic" &&
    helper.source?.head === head && helper.worktree === worktree);
  if (!matches.length) return undefined;
  const latest = matches.reduce((at, row) => row.acceptedAt > at ? row.acceptedAt : at, "");
  const current = matches.filter(row => row.acceptedAt === latest).map(row => reportFindings(row.report, head));
  const [first] = current;
  if (current.some(other => other.path !== first.path || other.sha256 !== first.sha256)) {
    throw new Error("ambiguous accepted critic reports for the same worktree, head and timestamp");
  }
  return first;
}

function reportFindings(report, head) {
  const content = JSON.parse(readEvidence(report.path, report).text);
  if (content.source?.head !== head || !content.findings?.sha256 || !content.findings?.path) throw new Error("accepted critic report lacks the findings fingerprint for this head");
  return content.findings;
}
