// A credential can prevent a repository-owned validation command from starting.
// Resolve the committed preflight and report only the credential name, never its value.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Verify a required credential from an unconditional shell preflight before any lane command. */
export function credentialLimitation(worktree, head, command, env = process.env) {
  if (!worktree || !/^[0-9a-f]{40}$/.test(head ?? "")) return null;
  const read = file => {
    const bytes = execFileSync("git", ["-C", worktree, "show", head + ":" + file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 });
    const local = path.join(realpathSync(worktree), file);
    return realpathSync(local) === local && readFileSync(local, "utf8") === bytes ? bytes : "";
  };
  const npm = /^(?:npm run|pnpm(?: run)?|yarn(?: run)?) ([\w:-]+)$/.exec(command);
  const shell = /^(?:bash |sh |\.\/)((?:[\w.-]+\/)*[\w.-]+\.sh)$/.exec(command);
  let script;
  try {
    if (npm) script = JSON.parse(read("package.json")).scripts?.[npm[1]];
    else if (shell && !shell[1].split("/").some(part => part === "." || part === "..")) script = read(shell[1]);
  } catch { return null; }
  if (typeof script !== "string") return null;
  const prefix = script.replace(/^#![^\n]*\n/, "").trimStart();
  const match = /^:\s+"\$\{([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)):\?[^}"\n]*\}"\s*(?:&&|;|\n)/.exec(prefix);
  if (!match || env[match[1]]) return null;
  return { credential: match[1], reason: `(orchestrator) ${command} was not run because ${match[1]} is unavailable. Engineering reviewer: provide the credential and run this check.` };
}

/** A verifier row needs the owning lane runner's observation for this exact source, command and scope. */
export function verifiedCredentialLimitation(row, source, records, worktree) {
  if (row?.status !== "not-run" || !source || row.commit !== source.head || !row.engineeringCredential) return false;
  const expected = credentialLimitation(worktree, source.head, row.command);
  const matching = records.filter(record => record.command === row.command && record.laneKey === row.laneKey &&
    record.source?.head === source.head && record.source.treeSha256 === source.treeSha256 && record.source.diffSha256 === source.diffSha256);
  return expected?.credential === row.engineeringCredential && row.reason === expected.reason &&
    matching.some(record => record.result === "not-run" && record.engineeringCredential === expected.credential && record.reason === expected.reason) &&
    !matching.some(record => record.result === "fail");
}

/** Every engineer-owned outstanding check must be visible under the PR body's Engineering review heading. */
export function engineeringBodyProblems(body, rows = []) {
  if (!Array.isArray(rows)) return [];
  const section = /^#{1,6}\s+Engineering review\s*\r?\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(body)?.[1] ?? "";
  return rows.filter(row => row.engineeringCredential && (row.status !== "not-run" || !row.reason || !section.includes(row.reason)))
    .map(row => `Engineering review must name the pending check and its credential limitation: ${row.command}`);
}
