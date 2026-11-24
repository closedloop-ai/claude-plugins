import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** The owned Claude child's stop and its proof: a turn is not a free writer slot until its process group is gone. */
export class OwnedCleanupError extends Error {}
export class OwnedSignalRefusal extends OwnedCleanupError {
  constructor(readonly pid: number) {
    super(`This execution host refused signaling the exact owned Claude process ${pid}. Keep its owner record. Wait for the process to stop, or ask the launching host's operator to stop that same recorded process. Verify that its group stopped before resuming.`);
  }
}

/** Completion is not a free writer slot until the owned process group is proven stopped. */
export async function finishOwnedGroup(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.pid <= 1) return;
  if (process.platform === "win32") {
    throw new OwnedCleanupError("Owned descendant cleanup is unsupported on this platform; writer lease retained for stopped-turn proof");
  }
  signalOwnedChild(child, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(-child.pid, 0); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw signalFailure(child.pid, error);
    }
    if (attempt === 5) signalOwnedChild(child, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new OwnedCleanupError("Owned process group is still present; writer lease retained for stopped-turn proof");
}

/**
 * Ask the owned child to stop: SIGTERM on every call, and only a delivered SIGTERM earns the later SIGKILL. A refused
 * SIGTERM (`send` false) schedules nothing, so the host's refusal is never answered with a stronger signal.
 */
export function escalateOwnedStop<T>(send: (signal: NodeJS.Signals) => boolean, schedule: (escalate: () => void) => T): T | null {
  return send("SIGTERM") ? schedule(() => { send("SIGKILL"); }) : null;
}

/** Signal the owned child's process group; a host refusal (EPERM, EACCES) keeps the owner record. */
export function signalOwnedChild(child: Pick<ChildProcessWithoutNullStreams, "pid" | "kill">, signal: NodeJS.Signals) {
  if (!child.pid || child.pid <= 1) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw signalFailure(child.pid, error);
  }
}

function signalFailure(pid: number, error: unknown): OwnedCleanupError {
  if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
    return new OwnedSignalRefusal(pid);
  }
  return new OwnedCleanupError("Unable to prove the owned process group stopped; writer lease retained", { cause: error });
}
