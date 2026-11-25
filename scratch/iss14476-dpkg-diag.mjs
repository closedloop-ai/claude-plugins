// ISS-14476 cloud diagnostic for r23's node-tests exit 100. In order, it records:
// 1. the dpkg state of zsh and zsh-common, dpkg --audit, any pending dpkg journal and any apt, dpkg or
//    unattended-upgrades process, all before any apt runs;
// 2. PATH;
// 3. ci.yml's exact node-tests step, `sudo apt-get update -qq && sudo apt-get install -y -qq zsh`, with its exit code, the
//    lines around its first error, and the dpkg state after.
// It prints one summary of at most 950 characters so the cloud run log keeps it whole, and exits with the step's code.
// For a scratch proof commit only (scratch/iss14476-dpkg-diag.mjs); it is never committed to the branch.
import { spawnSync } from "node:child_process";

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { code: result.status ?? result.error?.code ?? result.signal, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};
const flat = (text) => text.trim().replace(/\s+/g, " ");
const state = () => ({
  status: flat(run("dpkg-query", ["-W", "-f=${Package}=${Version}:${db:Status-Abbrev} ", "zsh", "zsh-common"]).out) || "absent",
  audit: run("dpkg", ["--audit"]).out.split("\n").filter(Boolean).length,
});
const before = {
  uid: flat(run("id", ["-u"]).out),
  zsh: flat(run("sh", ["-c", "command -v zsh"]).out) || "none",
  ...state(),
  journal: flat(run("sh", ["-c", "ls /var/lib/dpkg/updates 2>/dev/null | wc -l"]).out),
  holders: flat(run("sh", ["-c", "ps -eo comm= | grep -E '(^|/)(apt|apt-get|apt-check|apt.systemd.daily|dpkg|unattended-upgr[a-z]*)$' | sort | uniq -c"]).out) || "none",
};
const path = (process.env.PATH ?? "").slice(0, 200);
const step = run("bash", ["-c", "sudo apt-get update -qq && sudo apt-get install -y -qq zsh"]);
const lines = step.out.split("\n");
const first = lines.findIndex((line) => /error processing package|returned error exit status|Could not get lock|dpkg was interrupted|Failed to fetch|Temporary failure|Permission denied/i.test(line));
const around = first < 0 ? "none" : lines.slice(Math.max(0, first - 4), first + 2).map(flat).join(" | ");
const after = state();
const summary = `DPKG-DIAG before uid=${before.uid} zsh=${before.zsh} [${before.status}] audit=${before.audit} journal=${before.journal} holders=[${before.holders}]`
  + ` | step exit=${step.code} bytes=${step.out.length} first-error: ${around}`
  + ` | after [${after.status}] audit=${after.audit} | PATH=${path}`;
console.log(summary.slice(0, 950));
process.exitCode = typeof step.code === "number" ? step.code : 1;
