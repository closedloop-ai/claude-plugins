import { parse } from "yaml";
import { z } from "zod";

const workspace = z.object({ packages: z.array(z.string()).optional() }).passthrough();

/** Read pnpm workspace patterns, preserving the distinction between an absent list and an empty list. */
export function workspacePackages(source: string): string[] | undefined {
  return workspace.parse(parse(source)).packages;
}
