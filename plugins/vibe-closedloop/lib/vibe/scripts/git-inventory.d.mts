interface InventoryOptions {
  timeout?: number;
  maxBuffer?: number;
}

export function readGitInventory(worktree: string, args: string[], options?: InventoryOptions & { encoding?: BufferEncoding }): string;
export function readGitInventory(worktree: string, args: string[], options: InventoryOptions & { encoding: "buffer" }): Buffer;
export function readGitInventory<Result>(worktree: string, args: string[], options: InventoryOptions & {
  encoding?: BufferEncoding | "buffer";
  run: (command: string, args: string[], options: { encoding: string; timeoutMs: number; maxBuffer: number }) => Result;
}): Result;
