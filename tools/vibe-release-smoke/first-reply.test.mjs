import assert from "node:assert/strict";
import test from "node:test";
import { assessFirstReply, findSetupBlock } from "./first-reply.mjs";

const expected = { harness: "Codex", versions: { "closedloop-core": "1.5.3", vibe: "1.1.13" }, maxSeconds: 90 };
const CHECK = "/bin/zsh -lc \"node '/h/.codex/plugins/cache/closedloop-ai/vibe/1.1.13/skills/vibe/scripts/plugin-version.mjs' check --runtime codex --closedloop connected --graph connected\"";
const block = (codexLine) => ["Setup check", codexLine, "- ClosedLoop connection: connected", "- closedloop-graph connection: connected"].join("\n");
const passing = {
  messages: [{ t: 12.4, phase: "commentary", text: `${block("- Codex: closedloop-core 1.5.3 (latest), vibe 1.1.13 (latest)")}\n\nWhat do you want to work on?` }],
  commands: [
    { command: CHECK, exitCode: 0, output: '{"status":"unknown","escalate":true,"recordError":"EPERM: operation not permitted"}' },
    { command: CHECK, exitCode: 0, output: '{"status":"current","print":true}', approval: "accept" },
  ],
  expected,
};

test("a first reply with the installed versions, a completed comparison and a saved record passes", () => {
  assert.deepEqual(assessFirstReply(passing), []);
  assert.deepEqual(findSetupBlock(passing.messages).lines.slice(0, 2), ["Setup check", "- Codex: closedloop-core 1.5.3 (latest), vibe 1.1.13 (latest)"]);
  const outdated = { ...passing, messages: [{ t: 9, text: block("- Codex: closedloop-core 1.5.3 (latest), vibe 1.1.13 (1.1.14 available)") }] };
  assert.deepEqual(assessFirstReply(outdated), []);
});

test("what main shipped in vibe 1.1.12 fails: no comparison, the not-run line, the unknown line, an unsaved record", () => {
  const pm = {
    messages: [
      { t: 19.4, text: "I couldn’t check whether vibe is up to date, so I’m carrying on with the version you have." },
      { t: 59.2, text: block("- Plugins: the version check has not run in this conversation") },
    ],
    commands: [{ command: CHECK.replace(" --closedloop connected --graph connected", ""), exitCode: 0, output: '{"status":"unknown","recordError":"EPERM: operation not permitted, mkdir"}' }],
    expected,
  };
  const failures = assessFirstReply(pm);
  assert.ok(failures.some((failure) => failure.includes("has no Codex line")), failures.join("\n"));
  assert.ok(failures.some((failure) => failure.includes("has not run")));
  assert.ok(failures.some((failure) => failure.includes("could not be checked")), "a typographic apostrophe still counts");
  assert.ok(failures.some((failure) => failure.includes("could not finish or save its record")));

  const smokeOnMain = { ...passing, messages: [{ t: 24.8, text: block("- Codex: closedloop-core 1.5.3, vibe 1.1.13") }] };
  assert.equal(assessFirstReply(smokeOnMain).filter((failure) => failure.includes("completed latest-version comparison")).length, 2);
});

test("unchecked, wrong or missing versions, a late block and a missing check all fail", () => {
  const unchecked = { ...passing, messages: [{ t: 5, text: block("- Codex: closedloop-core 1.5.3 (couldn't check for a newer version), vibe 1.1.13 (latest)") }] };
  assert.match(assessFirstReply(unchecked).join("\n"), /completed latest-version comparison for closedloop-core/);
  const wrong = { ...passing, messages: [{ t: 5, text: block("- Codex: closedloop-core 1.5.3 (latest), vibe 1.1.12 (latest)") }] };
  assert.match(assessFirstReply(wrong).join("\n"), /does not show the installed vibe 1\.1\.13/);
  const late = { ...passing, messages: [{ ...passing.messages[0], t: 120 }] };
  assert.match(assessFirstReply(late).join("\n"), /after 120s, over the 90s budget/);
  assert.deepEqual(assessFirstReply({ ...passing, messages: [{ t: 3, text: "Hello" }] }), ["no agent message carried the setup check block"]);
  assert.match(assessFirstReply({ ...passing, commands: [] }).join("\n"), /never ran/);
  const failedLast = { ...passing, commands: [passing.commands[1], { command: CHECK, exitCode: 1, output: "" }] };
  assert.match(assessFirstReply(failedLast).join("\n"), /last startup command could not finish/);
});
