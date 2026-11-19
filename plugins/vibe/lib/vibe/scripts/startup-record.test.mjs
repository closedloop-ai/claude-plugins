import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { blockingProblem, compareVersions, markPending } from "./startup-record.mjs";
import { LoadBasis, loadedSkillEvidence } from "./loaded-skill.mjs";
import { vibeRoot } from "../../../shared/vibe-install.mjs";
import { makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";

const CONVERSATION = "conversation-1";
const loaded = (actor = CONVERSATION, runtime = "claude") => loadedSkillEvidence(actor, runtime, vibeRoot(), "vibe", LoadBasis.HookObserved);

test("versions compare numerically and anything else is not comparable", () => {
  assert.equal(compareVersions("1.0.52", "1.0.53"), -1);
  assert.equal(compareVersions("1.0.53", "1.0.53"), 0);
  assert.equal(compareVersions("1.0.100", "1.0.99"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), null);
  assert.equal(compareVersions("1.0.52", undefined), null);
});

test("a started session is pending until the check runs, and a later start keeps what was recorded", (t) => {
  const { home, cleanup } = makeHome("vibe-startup-record-");
  t.after(cleanup);
  const pending = markPending(CONVERSATION, home);
  assert.equal(pending.status, "pending");
  assert.match(blockingProblem(pending), /has not run/);
  writeFileSync(path.join(home, ".codex", "vibe", "plugin-version", `${CONVERSATION}.json`), JSON.stringify({ status: "outdated", versions: "vibe: x", choice: { choice: "proceed" } }));
  assert.equal(markPending(CONVERSATION, home).choice.choice, "proceed");
  assert.equal(blockingProblem({ status: "outdated", versions: "vibe: x" }), "plugins are outdated (vibe: x) and the person has not chosen to update or to proceed");
  assert.equal(blockingProblem({ status: "unknown" }), null, "no load-evidence source: the earlier behavior");
  assert.equal(blockingProblem({ status: "unknown", loadedSkill: loaded() }), null);
  assert.match(blockingProblem({ status: "unknown", loadedSkillRequired: true }), /recorded no load of the current vibe\/fleet skill/);
  assert.equal(blockingProblem(null), null);
  assert.throws(() => markPending("../escape", home), /invalid conversation id/);
});
