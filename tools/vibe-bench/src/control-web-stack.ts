import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { LOCAL_MCP_URL } from "./contract.ts";
import type { SeededStackAdapter } from "./lifecycle.ts";
import { terminateProcessGroup } from "./owned-process.ts";

interface ControlMeta {
  name: string;
  kind: string;
  pid: number;
  state: string;
  readOnly: boolean;
  baseUrl?: string;
  apiBaseUrl?: string;
  stack?: {
    isolated: boolean;
    attached: boolean;
    worktree: string;
    database?: { name: string; isolated: boolean };
  };
}

interface ControlStatus {
  running: boolean;
  meta?: ControlMeta;
}

export interface WebStackDetails {
  session: string;
  controlPid: number;
  mcpPid: number;
  webUrl: string;
  apiUrl: string;
  databaseName: string;
  apiKeyFile: string;
  seedStages: number;
  costCardRows: number;
  setupMs: number;
}

function commandJson(output: string): unknown {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("benchmark-command-json-missing");
  return JSON.parse(output.slice(start));
}

function loopback(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
    !parsed.username && !parsed.password;
}

function mcpPortOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 3010 });
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

/**
 * One owned web-only control stack, seeded into its isolated database. The
 * control CLI owns its daemon, ports, headless Chromium and database cleanup;
 * this adapter owns only its session claim and the separate local MCP group.
 */
export class ControlWebStackAdapter implements SeededStackAdapter {
  private readonly sourceCheckout: string;
  private readonly sandboxRoot: string;
  private readonly session: string;
  private controlPid: number | null = null;
  private mcp: ChildProcess | null = null;
  private detailsValue: WebStackDetails | null = null;

  constructor(sourceCheckout: string, sandboxRoot: string) {
    this.sourceCheckout = realpathSync(sourceCheckout);
    this.sandboxRoot = realpathSync(sandboxRoot);
    this.session = `iss13401-${randomBytes(4).toString("hex")}`;
  }

  /** Start a fresh isolated web stack, seed it and attach local apps/mcp. */
  async start(): Promise<void> {
    if (this.controlPid !== null || this.mcp !== null) throw new Error("benchmark-stack-already-owned");
    const started = Date.now();
    if ((await this.controlStatus()).running || await mcpPortOpen()) {
      throw new Error("benchmark-stack-foreign-process");
    }
    const origin = execFileSync("git", ["-C", this.sourceCheckout, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    if (!/[:/]closedloop-ai\/symphony-alpha(?:\.git)?$/.test(origin)) {
      throw new Error("benchmark-stack-not-symphony-alpha");
    }
    try {
      const meta = this.control("up", "web", "--isolated", "--allow-write", "--session", this.session) as ControlMeta;
      if (meta.name === this.session && Number.isInteger(meta.pid)) this.controlPid = meta.pid;
      this.validateMeta(meta);
      const databaseName = meta.stack!.database!.name;
      const databaseUrl = this.isolatedDatabaseUrl(databaseName);
      const apiKeyFile = join(this.sandboxRoot, "seed-api-key");
      const seed = this.pnpm(["-C", "apps/api", "run", "--silent", "vibe:seed", "--database-url", databaseUrl, "--api-key-out", apiKeyFile], {
        DATABASE_URL: databaseUrl,
      });
      const seeded = commandJson(seed) as { ok?: boolean; stages?: unknown[]; rowCounts?: Record<string, number>; error?: string };
      if (seeded.ok !== true) throw new Error(`benchmark-seed-failed: ${seeded.error ?? "unknown"}`);
      const costCardRows = seeded.rowCounts?.ClaudeCodeSessionTelemetry ?? 0;
      if ((seeded.rowCounts?.Project ?? 0) < 1 || costCardRows < 1) {
        throw new Error("benchmark-seed-cost-card-empty");
      }
      const log = openSync(join(this.sandboxRoot, "mcp.log"), "a", 0o600);
      const mcp = spawn("pnpm", ["dev"], {
        cwd: join(this.sourceCheckout, "apps/mcp"),
        detached: true,
        stdio: ["ignore", log, log],
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          CLOSEDLOOP_API_URL: meta.apiBaseUrl,
          MCP_SERVER_URL: LOCAL_MCP_URL.replace(/\/mcp$/, ""),
          NEXT_PUBLIC_POSTHOG_KEY: "",
        },
      });
      closeSync(log);
      this.mcp = mcp;
      let spawnFailed = false;
      mcp.once("error", () => { spawnFailed = true; });
      mcp.unref();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (spawnFailed || mcp.exitCode !== null || mcp.signalCode !== null) {
          throw new Error("benchmark-mcp-exited-before-ready");
        }
        if (await this.mcpHealthy()) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!(await this.mcpHealthy()) || !mcp.pid) throw new Error("benchmark-mcp-not-ready");
      this.detailsValue = {
        session: this.session,
        controlPid: meta.pid,
        mcpPid: mcp.pid,
        webUrl: meta.baseUrl!,
        apiUrl: meta.apiBaseUrl!,
        databaseName,
        apiKeyFile,
        seedStages: seeded.stages?.length ?? 0,
        costCardRows,
        setupMs: Date.now() - started,
      };
    } catch (error) {
      // A CLI failure can occur after control has started its daemon. Reclaim
      // only our unpredictable session and exact PID before cleanup.
      if (this.controlPid === null) {
        try {
          const current = await this.controlStatus();
          if (current.running && current.meta?.name === this.session && Number.isInteger(current.meta.pid)) {
            this.controlPid = current.meta.pid;
          }
        } catch { /* keep the original launch failure */ }
      }
      await this.stop();
      throw error;
    }
  }

  /** Reuse only when the same control PID and local MCP are healthy. */
  async healthy(): Promise<boolean> {
    if (!this.detailsValue || !this.mcp || this.mcp.exitCode !== null) return false;
    const status = await this.controlStatus();
    return status.running && status.meta?.pid === this.controlPid && await this.mcpHealthy();
  }

  /** Return the URLs and local key file after a successful seed. */
  details(): WebStackDetails {
    if (!this.detailsValue) throw new Error("benchmark-stack-not-ready");
    return this.detailsValue;
  }

  /** Stop this MCP group and this control session, never another ticket's. */
  async stop(): Promise<void> {
    const failures: unknown[] = [];
    const mcp = this.mcp;
    this.mcp = null;
    if (mcp?.pid) {
      try { await terminateProcessGroup(mcp.pid, "SIGTERM"); }
      catch (error) { failures.push(error); }
    }
    const pid = this.controlPid;
    this.controlPid = null;
    this.detailsValue = null;
    if (pid !== null) {
      try {
        const current = await this.controlStatus();
        if (current.running && current.meta?.pid === pid) this.control("down", "--session", this.session);
        else if (current.running) throw new Error("benchmark-stack-owner-changed");
      } catch (error) { failures.push(error); }
    }
    rmSync(join(this.sandboxRoot, "seed-api-key"), { force: true });
    if (failures.length) throw new AggregateError(failures, "benchmark-stack-cleanup-failed");
  }

  private control(...args: string[]): unknown {
    const output = commandJson(this.pnpm(["control", ...args])) as { ok?: boolean; result?: unknown; error?: string };
    if (output.ok !== true) throw new Error(`benchmark-control-command-failed: ${output.error ?? "unknown"}`);
    return output.result;
  }

  private async controlStatus(): Promise<ControlStatus> {
    return this.control("status", "--session", this.session) as ControlStatus;
  }

  private pnpm(args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
    return execFileSync("pnpm", args, {
      cwd: this.sourceCheckout,
      encoding: "utf8",
      timeout: 12 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      // The remote slot's login PATH omits Homebrew's executable directory,
      // where the control skill's required `just` binary is installed.
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`, NEXT_PUBLIC_POSTHOG_KEY: "", ...extraEnv },
    });
  }

  private isolatedDatabaseUrl(name: string): string {
    const script = "import { developerDatabaseUrl, withDatabase } from './.claude/skills/control/scripts/stack-db.ts'; process.stdout.write(withDatabase(developerDatabaseUrl(), process.argv[1]));";
    const url = execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script, name], {
      cwd: this.sourceCheckout, encoding: "utf8",
    }).trim();
    const parsed = new URL(url);
    if (parsed.protocol !== "postgresql:" || !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
      throw new Error("benchmark-database-not-local");
    }
    if (parsed.pathname.slice(1) !== name || !name.startsWith("control_")) {
      throw new Error("benchmark-database-not-isolated");
    }
    return url;
  }

  private validateMeta(meta: ControlMeta): void {
    if (meta.name !== this.session || meta.kind !== "web" || meta.state !== "ready" || meta.readOnly ||
        !Number.isInteger(meta.pid) || !meta.stack?.isolated || meta.stack.attached ||
        !meta.stack.database?.isolated || !meta.stack.database.name.startsWith("control_") ||
        realpathSync(meta.stack.worktree) !== this.sourceCheckout ||
        !meta.baseUrl || !loopback(meta.baseUrl) || !meta.apiBaseUrl || !loopback(meta.apiBaseUrl)) {
      throw new Error("benchmark-control-boundary-invalid");
    }
  }

  private async mcpHealthy(): Promise<boolean> {
    try {
      const response = await fetch(LOCAL_MCP_URL.replace(/\/mcp$/, "/health"), { signal: AbortSignal.timeout(500) });
      return response.ok && (await response.json()).status === "ok";
    } catch {
      return false;
    }
  }
}
