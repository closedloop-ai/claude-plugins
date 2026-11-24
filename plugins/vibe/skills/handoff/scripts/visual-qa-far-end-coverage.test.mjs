import { encodePng } from "./png-diff.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { visualQaFindingsProblems } from "../../../lib/vibe/scripts/required-visual-qa.mjs";
import { farEndCoveragePasses, validFarEndCoverage } from "../../../lib/vibe/scripts/viewport-overflow.mjs";
import { makeHome } from "../../vibe/scripts/test-fixtures.mjs";

const height = 480;
const bands = 8;
const coverage = (filled) => ({ height, bands, filled });

test("ISS-14476 far-end coverage needs strictly more than half the visible height bands", () => {
  assert.equal(farEndCoveragePasses(coverage([0, 1, 2, 3, 4]), height), true);
  assert.equal(farEndCoveragePasses(coverage([0, 2, 5, 7]), height), false);
  assert.equal(farEndCoveragePasses(coverage([0]), height), false);
  assert.equal(farEndCoveragePasses(coverage([]), height), false);
  assert.equal(farEndCoveragePasses({ height: 20, bands: 1, filled: [0] }, 20), true);
  for (const bad of [coverage([0, 0, 1, 2, 3]), coverage([0, 1, 2, 3, 8]), { height, bands: 1, filled: [0] }, null]) {
    assert.equal(validFarEndCoverage(bad, height), false);
  }
});

test("ISS-14476 findings reject a 2,102px track with a blank 390px far end", (t) => {
  const { root, cleanup } = makeHome("vibe-qa-blank-track-");
  t.after(cleanup);
  const head = "a".repeat(40);
  const file = "apps/app/issues.tsx";
  const png = encodePng({ width: 1, height: 1, data: Buffer.alloc(4) });
  for (const name of ["rest.png", "far.png"]) writeFileSync(path.join(root, name), png);
  const entry = {
    path: "#issues", scrollWidth: 2102, clientWidth: 390, scrollHeight: height, clientHeight: height,
    horizontal: true, vertical: false, blocking: false, farEndPng: "far.png",
    protruding: { x: { path: "#add-new-issue" } },
  };
  const capture = {
    surface: "web", target: "/issues", viewport: "390x550", theme: "light", paths: [file], png: "rest.png",
    overflow: { width: 390, height: 550, checkedContainers: 2, entries: [entry] },
  };
  const record = { head, findings: [], rounds: [{ id: "vqa-6d", head, runtime: "web", captures: [capture] }] };
  const findings = path.join(root, "findings.json");
  const validate = (farEndCoverage) => {
    entry.farEndCoverage = farEndCoverage;
    writeFileSync(findings, JSON.stringify(record));
    return visualQaFindingsProblems(findings, head, null, null, { paths: [file] });
  };
  assert.match(validate(coverage([7])).join("\n"), /blank far-end viewport.*1\/8.*#add-new-issue/);
  assert.match(validate(coverage([0, 2, 5, 7])).join("\n"), /blank far-end viewport.*4\/8/);
  assert.match(validate(undefined).join("\n"), /needs far-end foreground coverage/);
  assert.match(validate({ height, bands: 1, filled: [0] }).join("\n"), /needs far-end foreground coverage/);
  assert.deepEqual(validate(coverage([1, 2, 3, 4, 5])), []);
});
