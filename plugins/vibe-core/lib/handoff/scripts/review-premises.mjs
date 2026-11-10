import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const text = value => typeof value === "string" && value.trim() !== "";

/** Structural premise evidence; factual meaning is rechecked by the orchestrator. */
export function premiseProblems(finding, worktree) {
  const name = finding?.id ?? "finding";
  if (!Array.isArray(finding?.premises) || finding.premises.length === 0) {
    return [`${name}: list every material premise and its source`];
  }
  return finding.premises.flatMap((premise, index) => {
    const label = `${name} premise ${index + 1}`;
    if (!text(premise?.claim)) return [`${label}: claim is missing`];
    const evidence = premise.evidence;
    if (evidence?.kind === "UNVERIFIED") {
      return finding.blocking ? [`${label}: UNVERIFIED premise cannot support a blocking finding`] : text(evidence.reason) ? [] : [`${label}: UNVERIFIED needs a reason`];
    }
    if (evidence?.kind === "code") {
      if (!text(evidence.file) || !Number.isSafeInteger(evidence.line) || evidence.line < 1 || !text(evidence.fact)) return [`${label}: code evidence needs file, line and fact`];
      const root = realpathSync(worktree);
      const named = path.resolve(root, evidence.file);
      if (named !== root && !named.startsWith(`${root}${path.sep}`)) return [`${label}: code path escapes the reviewed worktree`];
      if (!existsSync(named)) return [`${label}: code file or line cannot be read`];
      const file = realpathSync(named);
      if (file === root || !file.startsWith(`${root}${path.sep}`)) return [`${label}: code path escapes the reviewed worktree`];
      if (!statSync(file).isFile() || readFileSync(file, "utf8").split("\n").length < evidence.line) return [`${label}: code file or line cannot be read`];
      return [];
    }
    if (evidence?.kind === "command") return text(evidence.command) && text(evidence.result) ? [] : [`${label}: read-only command and actual result are required`];
    if (evidence?.kind === "official-doc") return /^https:\/\/\S+/.test(evidence.url ?? "") && text(evidence.fact)
      && Number.isFinite(Date.parse(evidence.checkedAt ?? "")) ? [] : [`${label}: current official URL, fact and checkedAt are required`];
    return [`${label}: evidence kind must be code, command, official-doc or UNVERIFIED`];
  });
}
