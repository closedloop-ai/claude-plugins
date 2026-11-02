import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFixture } from "./fixture.ts";
import { prepareClaudeLaunch } from "./launch.ts";
import { projectSearchOracle } from "../oracle/project-search-oracle.ts";

/** Prepare a local-only fixture and a reviewable Claude launch manifest. */
export function preparePhase0(sourceCheckout: string, sandboxRoot: string, pluginDir: string): string {
  const fixture = prepareFixture(sourceCheckout, sandboxRoot);
  const oracleBefore = projectSearchOracle(fixture.agentCheckout);
  if (oracleBefore.pass) throw new Error("benchmark-fixture-not-regressed");
  const launch = prepareClaudeLaunch(fixture, resolve(pluginDir));
  const manifestFile = resolve(sandboxRoot, "phase0-manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify({ fixture, launch, oracleBefore }, null, 2)}\n`, { flag: "wx" });
  return manifestFile;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 5) {
    throw new Error("usage: phase0.ts <clean symphony-alpha checkout> <empty sandbox directory> <vibe plugin directory>");
  }
  process.stdout.write(`${preparePhase0(process.argv[2], process.argv[3], process.argv[4])}\n`);
}
