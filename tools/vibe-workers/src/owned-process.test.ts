import { describe, expect, it, vi } from "vitest";
import { safeFailure } from "./claude-worker.js";
import { escalateOwnedStop, signalOwnedChild } from "./owned-process.js";

describe("AC-42 owned-child stop under a host signal refusal", () => {
  const refusal = (code: string) => Object.assign(new Error(`kill ${code}`), { code });
  it("AC-42 never follows a refused SIGTERM with SIGKILL, and escalates a delivered one only once its timer fires", () => {
    const sent: string[] = [];
    const scheduled: Array<() => void> = [];
    const schedule = (escalate: () => void) => { scheduled.push(escalate); return scheduled.length; };
    expect(escalateOwnedStop((signal) => { sent.push(signal); return false; }, schedule)).toBeNull();
    expect([sent, scheduled.length]).toEqual([["SIGTERM"], 0]);
    sent.length = 0;
    expect(escalateOwnedStop((signal) => { sent.push(signal); return true; }, schedule)).toBe(1);
    expect(sent).toEqual(["SIGTERM"]);
    scheduled[0]!();
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
  });
  it("AC-42 classifies EPERM and EACCES as a refusal that keeps the owner record, and never signals pid 1 or below", () => {
    const child = { pid: 4242, kill: vi.fn() };
    for (const code of ["EPERM", "EACCES"]) {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw refusal(code); });
      let thrown: unknown;
      try { signalOwnedChild(child, "SIGTERM"); } catch (error) { thrown = error; }
      if (process.platform !== "win32") expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
      kill.mockRestore();
      expect(safeFailure(thrown)).toMatchObject({ code: "OWNED_PROCESS_SIGNAL_REFUSED" });
      expect(safeFailure(thrown).summary).toContain("exact owned Claude process 4242");
      expect(safeFailure(thrown).summary).toContain("Keep its owner record");
    }
    const other = vi.spyOn(process, "kill").mockImplementation(() => { throw refusal("EINVAL"); });
    let unproven: unknown;
    try { signalOwnedChild(child, "SIGKILL"); } catch (error) { unproven = error; }
    other.mockRestore();
    expect(safeFailure(unproven).code).toBe("OWNED_PROCESS_NOT_STOPPED");
    const gone = vi.spyOn(process, "kill").mockImplementation(() => { throw refusal("ESRCH"); });
    expect(() => signalOwnedChild(child, "SIGTERM")).not.toThrow();
    gone.mockRestore();
    const never = vi.spyOn(process, "kill");
    signalOwnedChild({ pid: 1, kill: vi.fn() }, "SIGTERM");
    signalOwnedChild({ pid: 0, kill: vi.fn() }, "SIGTERM");
    expect(never).not.toHaveBeenCalled();
    never.mockRestore();
  });
});
