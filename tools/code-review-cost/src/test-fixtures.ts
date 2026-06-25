/** Synthetic transcript builders shared by the cost-report test suites. */

import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UsageInit {
  input?: number;
  cacheRead?: number;
  output?: number;
  cw5?: number;
  cw1?: number;
}

/** Build an assistant transcript entry with a usage block and optional tool uses. */
export function assistantEntry(model: string, usage: UsageInit, opts?: { sidechain?: boolean; tools?: string[] }): unknown {
  const content: unknown[] = [];
  for (const name of opts?.tools ?? []) content.push({ type: "tool_use", name });
  return {
    type: "assistant",
    isSidechain: opts?.sidechain ?? false,
    message: {
      model,
      content,
      usage: {
        input_tokens: usage.input ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        output_tokens: usage.output ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: usage.cw5 ?? 0,
          ephemeral_1h_input_tokens: usage.cw1 ?? 0,
        },
      },
    },
  };
}

/** Build the opening user entry that marks a session as a code-review run. */
export function commandEntry(variant: string, args = ""): unknown {
  const argsBlock = args ? ` <command-args>${args}</command-args>` : "";
  return {
    type: "user",
    message: {
      content: `<command-message>${variant.slice(1)}</command-message> <command-name>${variant}</command-name>${argsBlock}`,
    },
  };
}

function toJsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

export interface AgentSpec {
  id: string;
  description: string;
  agentType?: string;
  lines: unknown[];
}

/**
 * Write a full project tree containing one code-review session plus its
 * subagents, returning the temp projects-root and the project dir name.
 */
export function writeSessionTree(opts: {
  project: string;
  sessionId: string;
  variant: string;
  /** Optional command-args text (e.g. "--depth deep") for depth resolution. */
  args?: string;
  mainLines: unknown[];
  agents?: AgentSpec[];
}): { root: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "cr-cost-"));
  const projectDir = join(root, opts.project);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${opts.sessionId}.jsonl`),
    toJsonl([commandEntry(opts.variant, opts.args ?? ""), ...opts.mainLines]),
  );
  if (opts.agents?.length) {
    const subdir = join(projectDir, opts.sessionId, "subagents");
    mkdirSync(subdir, { recursive: true });
    for (const a of opts.agents) {
      writeFileSync(join(subdir, `agent-${a.id}.jsonl`), toJsonl(a.lines));
      writeFileSync(
        join(subdir, `agent-${a.id}.meta.json`),
        JSON.stringify({ agentType: a.agentType ?? "code-review:code-review-worker", description: a.description }),
      );
    }
  }
  return { root, projectDir };
}
