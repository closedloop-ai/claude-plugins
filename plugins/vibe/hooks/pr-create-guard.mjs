// A vibe PR must carry a current private handoff witness for its exact source.
import path from "node:path";
import { commandSegments } from "./command-segments.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { inVibeSession } from "./foreground-guard.mjs";
import { handoffGateProblem } from "../skills/handoff/scripts/handoff-gate.mjs";
import { latestSkill, readTranscript } from "./skill-transcript.mjs";
import { readHookSkill } from "./hook-session-scope.mjs";
import os from "node:os";

/** Whether a shell call opens a PR through GitHub CLI. */
export function createsPullRequest(command) {
  return prCreateCalls(command, process.cwd()).length > 0;
}

/** Expand shell wrappers and carry `cd` into each PR command's effective cwd. */
export function prCreateCalls(command, initialCwd) {
  let cwd = initialCwd;
  let uncertainCwd = false;
  const directoryStack = [];
  const remote = commandSegments(command).some(({ words }) => path.basename(words[0] ?? "") === "ssh");
  const calls = [];
  for (const { words } of commandSegments(command, { expandShellPayloads: true })) {
    if (words[0] === "cd" || words[0] === "pushd") {
      if (words.length !== 2 || /[$`*?]/.test(words[1])) uncertainCwd = true;
      else {
        if (words[0] === "pushd") directoryStack.push(cwd);
        cwd = path.resolve(cwd, words[1]);
      }
      continue;
    }
    if (words[0] === "popd") {
      if (words.length !== 1 || directoryStack.length === 0) uncertainCwd = true;
      else cwd = directoryStack.pop();
      continue;
    }
    if (path.basename(words[0] ?? "") !== "gh" || words[1] !== "pr" || words[2] !== "create") continue;
    let base = null;
    let bodyFile = null;
    for (let i = 3; i < words.length; i += 1) {
      const word = words[i];
      if (["--base", "-B", "--body-file", "-F"].includes(word)) {
        const value = words[++i];
        if (word === "--base" || word === "-B") base = value;
        else bodyFile = value;
      } else if (word.startsWith("--base=")) base = word.slice(7);
      else if (word.startsWith("--body-file=")) bodyFile = word.slice(12);
    }
    calls.push({ cwd, base, bodyFile: bodyFile ? path.resolve(cwd, bodyFile) : null, remote, uncertainCwd });
  }
  return calls;
}

/** Refuse PR publication in a vibe session without the final handoff witness. */
export function prCreateGuard(event, home = os.homedir()) {
  const transcript = readTranscript(event?.transcript_path);
  const skill = transcript === null ? null : latestSkill(transcript, ["vibe", "fleet-orchestrator"]);
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return null;
  const calls = prCreateCalls(command, eventCwd(event));
  const recorded = inVibeSession(eventCwd(event)) || calls.some(call => !call.remote && !call.uncertainCwd && inVibeSession(call.cwd));
  if (skill !== "vibe" && skill !== "fleet-orchestrator" && !readHookSkill(event?.session_id, home) && !recorded) return null;
  for (const call of calls) {
    if (call.remote || call.uncertainCwd) return deny("gh pr create refused: remote or unresolved shell cwd cannot prove a local vibe handoff gate");
    if (!inVibeSession(call.cwd)) return deny("gh pr create refused: no vibe session record in the command worktree");
    const problem = handoffGateProblem(call.cwd, { base: call.base, bodyFile: call.bodyFile });
    if (problem) return deny(`gh pr create refused: ${problem}; run the final handoff gate on the published source`);
  }
  return null;
}
