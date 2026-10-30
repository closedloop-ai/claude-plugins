import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BENCHMARK_TASK, requireLocalBoundary } from "./contract.ts";

/** Disposable agent checkout and its local fake origin. */
export interface PreparedFixture {
  agentCheckout: string;
  bareRemote: string;
  baseSha: string;
  sourceSha: string;
  taskId: string;
  taskPrompt: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/**
 * Prepare a deliberately broken, disposable symphony-alpha checkout.
 * Its only origin is a local bare repository whose path satisfies vibe's
 * existing remote check. The private oracle remains in this tool's tree.
 */
export function prepareFixture(sourceCheckout: string, sandboxRoot: string): PreparedFixture {
  const source = realpathSync(sourceCheckout);
  const root = realpathSync(sandboxRoot);
  if (!existsSync(join(source, ".git"))) throw new Error("benchmark-source-not-checkout");
  if (git(source, "status", "--porcelain")) throw new Error("benchmark-source-not-clean");
  const sourceSha = git(source, "rev-parse", "HEAD^{commit}");
  const agentCheckout = join(root, "agent");
  const remoteParent = join(root, "closedloop-ai");
  const bareRemote = join(remoteParent, "symphony-alpha.git");
  if (existsSync(agentCheckout) || existsSync(bareRemote)) throw new Error("benchmark-fixture-exists");
  mkdirSync(remoteParent, { recursive: true });
  execFileSync("git", ["init", "--bare", bareRemote], { stdio: "ignore" });
  execFileSync("git", ["clone", "--local", "--shared", "--single-branch", "--branch", "main", source, agentCheckout], {
    stdio: "ignore",
  });
  // A detached current-main worktree can share an older local `main` ref.
  // Move only the disposable clone's main branch to the exact source commit.
  git(agentCheckout, "reset", "--hard", sourceSha);
  const target = join(agentCheckout, BENCHMARK_TASK.file);
  const original = readFileSync(target, "utf8");
  if (original.split(BENCHMARK_TASK.healthy).length !== 2) {
    throw new Error("benchmark-task-source-drift");
  }
  writeFileSync(target, original.replace(BENCHMARK_TASK.healthy, BENCHMARK_TASK.broken));
  git(agentCheckout, "add", BENCHMARK_TASK.file);
  git(agentCheckout, "-c", "user.name=vibe benchmark", "-c", "user.email=benchmark@invalid.local", "commit", "-m", "test: seed project search regression");
  git(agentCheckout, "remote", "set-url", "origin", bareRemote);
  git(agentCheckout, "remote", "set-url", "--push", "origin", bareRemote);
  requireLocalBoundary({
    sandboxRoot: root,
    fetchRemote: git(agentCheckout, "remote", "get-url", "origin"),
    pushRemote: git(agentCheckout, "remote", "get-url", "--push", "origin"),
    mcpUrl: "http://127.0.0.1:3010/mcp",
  });
  git(agentCheckout, "push", "-u", "origin", "main");
  const baseSha = git(agentCheckout, "rev-parse", "HEAD");
  git(agentCheckout, "switch", "-c", `benchmark/${BENCHMARK_TASK.id}`);
  return {
    agentCheckout: realpathSync(agentCheckout), bareRemote: realpathSync(bareRemote),
    baseSha, sourceSha, taskId: BENCHMARK_TASK.id, taskPrompt: BENCHMARK_TASK.prompt,
  };
}

/** Revalidate the actual git configuration immediately before launching Claude. */
export function verifyPreparedFixture(fixture: PreparedFixture, mcpUrl: string): void {
  const checkout = realpathSync(fixture.agentCheckout);
  const root = resolve(checkout, "..");
  requireLocalBoundary({
    sandboxRoot: root,
    fetchRemote: git(checkout, "remote", "get-url", "origin"),
    pushRemote: git(checkout, "remote", "get-url", "--push", "origin"),
    mcpUrl,
  });
  if (git(checkout, "rev-parse", "main^{commit}") !== fixture.baseSha) {
    throw new Error("benchmark-base-changed");
  }
  if (git(checkout, "branch", "--show-current") !== `benchmark/${fixture.taskId}`) {
    throw new Error("benchmark-branch-changed");
  }
}
