import { relative } from "node:path";
import { buildClosedLoopVibe, builtText, DEFAULT_PATHS, REPO } from "./build.js";

const [command, target] = process.argv.slice(2);
if (command === "--print" && target) {
  process.stdout.write(builtText(target));
} else if (command === undefined) {
  const count = buildClosedLoopVibe();
  console.log(`built ${count} files into ${relative(REPO, DEFAULT_PATHS.output)}`);
} else {
  console.error("usage: node build.mjs [--print <file relative to plugins/vibe-closedloop>]");
  process.exitCode = 2;
}
