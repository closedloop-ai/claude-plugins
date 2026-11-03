import { describe, expect, it } from "vitest";
import { biomeCheckCommands } from "./main-sync-checks.js";
import { reportExecutionSchema } from "./main-sync-report-execution.js";
import { fixedCommandSchema } from "./main-sync-validation-contracts.js";

const argvBound = reportExecutionSchema.shape.argv;

describe("Biome over a large change set", () => {
  it("splits more than 256 changed paths into commands every argv bound accepts, keeping every path once", () => {
    const paths = Array.from({ length: 300 }, (_, index) => `apps/app/file-${index}.ts`);
    expect(argvBound.safeParse(["pnpm", "exec", "biome", "check", ...paths]).success).toBe(false);
    const commands = biomeCheckCommands(paths);
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command.argv.slice(0, 4)).toEqual(["pnpm", "exec", "biome", "check"]);
      expect(argvBound.safeParse(command.argv).success).toBe(true);
      expect(fixedCommandSchema.shape.argv.safeParse(command.argv).success).toBe(true);
    }
    expect(commands.flatMap((command) => command.argv.slice(4))).toEqual(paths);
    expect(biomeCheckCommands([])).toEqual([]);
  });
});
