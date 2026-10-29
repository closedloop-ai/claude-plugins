// The vibe scripts that write under ~/.codex/vibe, run through the Codex app
// server's `command/exec` under the same workspace-write sandbox a session's
// turn gets, then again escalated (full access, the "Allow once" rerun).
// Unit tests and evals never see Codex's sandbox; these five scripts refused
// writes there silently or with a generic error until ISS-13321. Each must
// print `"escalate":true` with a justification in the sandbox, and do its job
// escalated.

/** Each writer: its command, the justification it must give, and whether its escalated rerun is safe to run here. */
export function sandboxWriters({ scripts, repo, head, node: nodePath = "node" }) {
  const node = (script, ...args) => [nodePath, `${scripts}/${script}`, ...args];
  return [
    { name: "vibe-preflight.sh", argv: ["/bin/bash", `${scripts}/vibe-preflight.sh`, "--runtime", "codex", "--repo", repo],
      justification: "Remember where your copy of the code is", escalated: true, cwd: repo },
    { name: "session-questions.mjs", argv: node("session-questions.mjs", "ask", "--key", "smoke", "--question", "Smoke question?",
      "--default", "carry on", "--deadline-minutes", "10"), justification: "Save the questions for this vibe session", escalated: true, cwd: repo },
    { name: "precedent-check.mjs", argv: node("precedent-check.mjs", "run", "--question", "Smoke question?", "--code-evidence", "README.md:1",
      "--claude", "/usr/bin/false", "--timeout-seconds", "5"), justification: "Save the comparison with the other app", escalated: false, cwd: repo },
    { name: "e2e-lock.mjs", argv: node("e2e-lock.mjs", "run", "--head", head, "--wait-seconds", "1", "true"),
      justification: "Reserve the shared setup for the automatic checks", escalated: true, cwd: repo },
    { name: "image-head.mjs", argv: node("image-head.mjs", "record", "--project", "vibe-smoke", "--worktree", repo, "--head", head, "--", "docker", "compose", "up", "--build"),
      justification: "Record which version the automatic checks' setup was built from", escalated: true, cwd: repo },
  ];
}

/** The escalation line in a command's output, or null. */
export function escalationIn(stdout) {
  for (const line of String(stdout ?? "").split("\n")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.escalate === true) return parsed;
    } catch {
      // Not a JSON line.
    }
  }
  return null;
}

/** What went wrong across the sandboxed and escalated runs; [] when every writer behaved. */
export function assessSandboxWriters(results) {
  return results.flatMap(({ writer, sandboxed, escalated }) => {
    const problems = [];
    const asked = escalationIn(sandboxed?.stdout);
    if (!asked) problems.push(`${writer.name}: the sandbox refused its write and it did not ask for an escalated rerun`);
    else if (asked.justification !== writer.justification) problems.push(`${writer.name}: justification "${asked.justification}", expected "${writer.justification}"`);
    if (writer.escalated && escalated && escalationIn(escalated.stdout)) problems.push(`${writer.name}: still asked to escalate when run with full access`);
    if (writer.escalated && !escalated) problems.push(`${writer.name}: the escalated rerun did not run`);
    return problems;
  });
}
