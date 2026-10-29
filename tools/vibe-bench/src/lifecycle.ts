/** Repository-specific commands for one owned seeded stack. */
export interface SeededStackAdapter {
  start(): Promise<void>;
  healthy(): Promise<boolean>;
  stop(): Promise<void>;
}

/** One agent run's claim on a seed with an independent working checkout. */
export interface StackLease {
  id: string;
  isolationKey: string;
}

/**
 * Own one local seeded stack plus local MCP process. The adapter owns
 * their repository-specific commands; this class owns reuse and cleanup.
 */
export class SeededStackLifecycle {
  private readonly adapter: SeededStackAdapter;
  private readonly leases = new Map<string, string>();
  private started = false;
  private isolationKey: string | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(adapter: SeededStackAdapter) {
    this.adapter = adapter;
  }

  /** Acquire only when callers can name the same seed and independent workspaces. */
  acquire(lease: StackLease): Promise<void> {
    return this.exclusive(async () => {
      if (!lease.id || !lease.isolationKey) throw new Error("benchmark-stack-lease-invalid");
      if (this.leases.has(lease.id)) throw new Error("benchmark-stack-lease-duplicate");
      if (this.isolationKey !== null && this.isolationKey !== lease.isolationKey) {
        throw new Error("benchmark-stack-isolation-mismatch");
      }
      if (!this.started) {
        await this.adapter.start();
        this.started = true;
        this.isolationKey = lease.isolationKey;
      } else if (!(await this.adapter.healthy())) {
        throw new Error("benchmark-stack-unhealthy");
      }
      this.leases.set(lease.id, lease.isolationKey);
    });
  }

  /** Stop immediately after the last run, even if that run failed. */
  release(id: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.leases.delete(id)) throw new Error("benchmark-stack-lease-unknown");
      if (this.leases.size === 0) await this.stop();
    });
  }

  /** Force cleanup for interruption; callers must record interrupted runs. */
  close(): Promise<void> {
    return this.exclusive(async () => {
      this.leases.clear();
      await this.stop();
    });
  }

  private exclusive(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await this.adapter.stop();
    } finally {
      this.started = false;
      this.isolationKey = null;
    }
  }
}
