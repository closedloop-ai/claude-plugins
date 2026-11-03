import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { main } from "./cost-report.js";
import { assistantEntry, writeSessionTree } from "./test-fixtures.js";

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  return {
    out,
    err,
    restore: () => {
      o.mockRestore();
      e.mockRestore();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

function tree() {
  return writeSessionTree({
    project: "myproj",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    variant: "/code-review:deep",
    mainLines: [
      assistantEntry("claude-opus-4-8", { cacheRead: 1_000_000, output: 10_000 }, { tools: ["Bash", "Agent"] }),
    ],
    agents: [
      { id: "p1", description: "Premise Reviewer", lines: [assistantEntry("claude-sonnet-4-6", { output: 100_000 })] },
      { id: "a1", description: "Unified Auditor", lines: [assistantEntry("claude-sonnet-4-6", { output: 100_000 })] },
    ],
  });
}

describe("cost-report CLI", () => {
  it("emits a JSON aggregate for --scan --json", () => {
    const { root } = tree();
    const cap = capture();
    const code = main(["--scan", "--projects-root", root, "--json"]);
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(""));
    expect(parsed.sessionCount).toBe(1);
    expect(parsed.roleCosts.some((r: { category: string }) => r.category === "premise")).toBe(true);
  });

  it("renders a text report for a single --session", () => {
    const { projectDir } = tree();
    const sessionPath = join(projectDir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    const cap = capture();
    const code = main(["--session", sessionPath]);
    cap.restore();
    expect(code).toBe(0);
    const text = cap.out.join("");
    expect(text).toContain("CODE-REVIEW COST REPORT");
    expect(text).toContain("MAIN ORCHESTRATOR vs SUBAGENT FLEET");
    expect(text).toContain("premise");
  });

  it("errors when no input selector is given", () => {
    const cap = capture();
    const code = main([]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain("one of --session");
  });

  it("saves a baseline and compares against it", () => {
    const { root } = tree();
    const baselinePath = join(mkdtempSync(join(tmpdir(), "cr-base-")), "baseline.json");
    let cap = capture();
    expect(main(["--scan", "--projects-root", root, "--save", baselinePath, "--json"])).toBe(0);
    cap.restore();

    cap = capture();
    const code = main(["--scan", "--projects-root", root, "--baseline", baselinePath]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out.join("")).toContain("COMPARISON vs BASELINE");
  });

  it("renders a COST BY DEPTH section and filters with --depth", () => {
    const { root } = tree(); // one /code-review:deep session
    let cap = capture();
    expect(main(["--scan", "--projects-root", root])).toBe(0);
    cap.restore();
    expect(cap.out.join("")).toContain("COST BY DEPTH");

    // filtering to a tier with no sessions yields exit 1
    cap = capture();
    const code = main(["--scan", "--projects-root", root, "--depth", "shallow"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.err.join("")).toContain("depth=shallow");

    // filtering to the present tier succeeds
    cap = capture();
    expect(main(["--scan", "--projects-root", root, "--depth", "deep", "--json"])).toBe(0);
    cap.restore();
    expect(JSON.parse(cap.out.join("")).sessionCount).toBe(1);
  });

  it("rejects an invalid --depth value", () => {
    const { root } = tree();
    const cap = capture();
    const code = main(["--scan", "--projects-root", root, "--depth", "medium"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err.join("")).toContain("--depth must be");
  });

  it("rejects a non code-review session path", () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-plain-"));
    const sessionPath = join(dir, "plain.jsonl");
    writeFileSync(sessionPath, JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n");
    const cap = capture();
    const code = main(["--session", sessionPath]);
    cap.restore();
    expect(code).toBe(1);
  });
});
