import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { evalCaseCatalog } from "./eval-selection.ts";

const REPO = realpathSync(join(import.meta.dirname, "../../.."));

test("ISS-13720 unchanged nightly prior matches the current writer definition offline", () => {
  const item = evalCaseCatalog(join(REPO, "plugins/vibe"))
    .find((candidate) => candidate.id === "upgrade-resume-unchanged-definition");
  assert.ok(item?.nightlyPrior);
  assert.equal(item.nightlyPrior.version, "1.1.38");
  const current = readFileSync(join(REPO, "plugins/vibe/agents/vibe-change-worker.md"));
  assert.equal(createHash("sha256").update(current).digest("hex"),
    item.nightlyPrior.writerDigestSha256);
});
