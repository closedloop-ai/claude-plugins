import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  approvalQuestion, approvalQuestionKey, flagKeyProblems, listedFlagKeys, proposals, renderFlagKeys, validateFlagKeys,
} from "./flag-keys.mjs";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "flag-keys.mjs");
const QUESTIONS = path.join(HERE, "session-questions.mjs");
const OPERATOR = { id: "user-operator", email: "operator@example.com", name: "Sample Operator" };

const REPO_RULE = "A flag is required for exactly four things: a net-new surface, a net-new screen, a net-new navigation item, or a gated rollout the author or a spec asks for.";

function newKey(overrides = {}) {
  return {
    key: "branches-list-v2",
    origin: "new",
    readAt: ["packages/app/branches/components/branches-list.tsx"],
    reason: "net-new-screen",
    repoRule: REPO_RULE,
    source: "PRD-729: the redesigned Branches list is a new screen",
    ...overrides,
  };
}

function existingKey(key, readAt = ["packages/app/shared/lib/feature-flags.ts"]) {
  return { key, origin: "existing", readAt };
}

function surface(keys, overrides = {}) {
  return { surface: "Branches list", hosts: ["web", "desktop"], keys, ...overrides };
}

test("a justified new key and the existing keys the work depends on are accepted and normalized", () => {
  const result = validateFlagKeys({
    surfaces: [surface([newKey({ readAt: ["b.tsx", "a.tsx", "a.tsx"] }), existingKey("labs-nav-section")], { hosts: ["web", "desktop"] })],
  });
  assert.deepEqual(result.surfaces[0].hosts, ["desktop", "web"]);
  assert.deepEqual(result.surfaces[0].keys[0].readAt, ["a.tsx", "b.tsx"]);
  assert.equal(result.surfaces[0].keys[0].reason, "net-new-screen");
  assert.deepEqual(Object.keys(result.surfaces[0].keys[1]), ["key", "origin", "readAt"]);
});

test("an empty set and a surface no key gates are valid records", () => {
  assert.deepEqual(validateFlagKeys({ surfaces: [] }), { surfaces: [] });
  assert.deepEqual(validateFlagKeys({ surfaces: [surface([])] }).surfaces[0].keys, []);
});

test("one behavior gets one key: a second new key on one surface is refused, with both named", () => {
  // The 2026-10-20 incident: one Branches list redesign behind three keys.
  assert.throws(
    () => validateFlagKeys({
      surfaces: [surface([
        newKey({ key: "branches-list-adapter-connected" }),
        newKey({ key: "branches-list-adapter-disconnected" }),
        newKey({ key: "branches-list-adapter-rollback" }),
      ])],
    }),
    /adds 3 new keys \(branches-list-adapter-connected, branches-list-adapter-disconnected, branches-list-adapter-rollback\); one behavior gets one key/
  );
});

test("a new key that is reused on a second surface is still one key", () => {
  const result = validateFlagKeys({
    surfaces: [surface([newKey()]), surface([newKey()], { surface: "Branches detail" })],
  });
  assert.equal(result.surfaces.length, 2);
});

test("a new key or new read with no justification is refused; an existing dependency needs none", () => {
  for (const missing of ["reason", "repoRule", "source"]) {
    const entry = newKey();
    delete entry[missing];
    assert.throws(() => validateFlagKeys({ surfaces: [surface([entry])] }), new RegExp(missing === "reason" ? "has no justification" : missing));
  }
  const unjustifiedRead = { key: "labs-nav-section", origin: "new-read", readAt: ["apps/app/page.tsx"] };
  assert.throws(() => validateFlagKeys({ surfaces: [surface([unjustifiedRead])] }), /has no justification: reason must be one of/);
  assert.throws(
    () => validateFlagKeys({ surfaces: [surface([newKey({ reason: "staged-rollout" })])] }),
    /with none of them, build the change ungated/
  );
  assert.doesNotThrow(() => validateFlagKeys({ surfaces: [surface([existingKey("labs-nav-section")])] }));
});

test("a spec-requested rollout must name the spec it comes from", () => {
  assert.throws(
    () => validateFlagKeys({ surfaces: [surface([newKey({ reason: "spec-requested-rollout", source: "the plan says to roll it out slowly" })])] }),
    /claims a spec-requested rollout, but its source names no ticket or spec slug/
  );
  assert.doesNotThrow(() => validateFlagKeys({
    surfaces: [surface([newKey({ reason: "spec-requested-rollout", source: "ISS-9488: ship behind a closed-by-default flag" })])],
  }));
});

test("a key that is new on one surface and existing on another is refused", () => {
  assert.throws(
    () => validateFlagKeys({ surfaces: [surface([newKey()]), surface([existingKey("branches-list-v2")], { surface: "Branches detail" })] }),
    /`branches-list-v2` is new on one surface and existing on another/
  );
});

test("malformed input reports every problem at once", () => {
  assert.throws(() => validateFlagKeys([]), /must be a JSON object with a surfaces array/);
  let message = "";
  try {
    validateFlagKeys({
      extra: true,
      surfaces: [
        { surface: "", hosts: ["ios"], keys: [{ key: "bad key", origin: "maybe", readAt: ["/abs/path.ts"], note: 1 }] },
        surface([existingKey("a"), existingKey("a")]),
        surface([]),
      ],
    });
  } catch (error) {
    message = error.message;
  }
  for (const problem of [
    'the file has unknown field "extra"',
    "surfaces[0].surface must be text",
    "surfaces[0].hosts must list at least one of web, desktop",
    "surfaces[0].keys[0].key must be a PostHog flag key",
    "surfaces[0].keys[0].origin must be one of new, new-read, existing",
    "must be a repo-relative path",
    'surfaces[0].keys[0] has unknown field "note"',
    "surfaces[1] lists `a` more than once",
    'surface "Branches list" is listed more than once',
  ]) {
    assert.ok(message.includes(problem), `${problem} in ${message}`);
  }
});

test("the ticket block lists every key per surface with the person's approval and its value in their snapshot", () => {
  const flagKeys = validateFlagKeys({
    surfaces: [
      surface([newKey(), existingKey("labs-nav-section")]),
      { surface: "Tags editor", hosts: ["web"], keys: [] },
    ],
  });
  const snapshot = { flags: { "labs-nav-section": true } };
  assert.equal(renderFlagKeys(flagKeys, snapshot), [
    "### Keys to see this work",
    "",
    "Every key listed for a surface must be on to see the work there.",
    "",
    "| Surface | Hosts | Key | Origin | Approval | In this snapshot |",
    "|---|---|---|---|---|---|",
    "| Branches list | Desktop, web | `branches-list-v2` | new key | pending approval, not built | not in snapshot |",
    "| Branches list | Desktop, web | `labs-nav-section` | existing key | on main | true |",
    "| Tags editor | web | none | - | - | - |",
  ].join("\n"));
  assert.equal(
    renderFlagKeys({ surfaces: [] }, snapshot),
    "### Keys to see this work\n\nNo visible surface changed; no key is needed."
  );
});

test("the cross-session list carries each surface's keys and origins, and none when unrecorded", () => {
  assert.equal(listedFlagKeys(null), null);
  const flagKeys = validateFlagKeys({ surfaces: [surface([newKey(), existingKey("labs-nav-section")])] });
  assert.deepEqual(listedFlagKeys(flagKeys), [{
    surface: "Branches list",
    hosts: ["desktop", "web"],
    keys: [{ key: "branches-list-v2", origin: "new", approval: "pending" }, { key: "labs-nav-section", origin: "existing" }],
  }]);
});

test("a proposed key may be recorded before it is built; an existing dependency must name its reads", () => {
  assert.deepEqual(validateFlagKeys({ surfaces: [surface([newKey({ readAt: undefined })])] }).surfaces[0].keys[0].readAt, []);
  assert.throws(
    () => validateFlagKeys({ surfaces: [surface([{ key: "labs-nav-section", origin: "existing", readAt: [] }])] }),
    /must list at least one repo-relative file that reads the key/
  );
});

test("the approval question shows the key, why, what it gates per surface and the full stack it sits behind", () => {
  const flagKeys = validateFlagKeys({
    surfaces: [
      surface([newKey(), existingKey("labs-nav-section")]),
      { surface: "Branches detail", hosts: ["web"], keys: [newKey(), existingKey("branches-detail-v1")] },
    ],
  });
  const proposal = proposals(flagKeys).get("branches-list-v2");
  assert.deepEqual(proposal.stack, ["branches-detail-v1", "labs-nav-section"]);
  assert.equal(approvalQuestion(proposal), [
    "Add the new feature switch `branches-list-v2`? It would keep this work hidden until the switch is on, on: Branches list (Desktop, web); Branches detail (web).",
    "Why: it is a new screen. Source: PRD-729: the redesigned Branches list is a new screen",
    "To see the work there, these switches would also have to be on: `branches-detail-v1`, `labs-nav-section`.",
    "Reply yes to add `branches-list-v2`, or no to build the change without a switch, so it shows for everyone once it ships.",
  ].join("\n"));
  assert.match(approvalQuestionKey(proposal), /^flag-approval:branches-list-v2:[0-9a-f]{12}$/);
  const alone = proposals(validateFlagKeys({ surfaces: [surface([newKey({ origin: "new-read", key: "labs-nav-section" })])] })).get("labs-nav-section");
  assert.match(approvalQuestion(alone), /^Put this work behind the existing feature switch `labs-nav-section`\?/);
  assert.match(approvalQuestion(alone), /No other switch gates this work there\./);
});

function flagSession(t) {
  const fixture = makeHome("flag-keys-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.root, "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout });
  const record = path.join(git(checkout, ["rev-parse", "--absolute-git-dir"], fixture.home), "vibe-session.json");
  writeFileSync(record, JSON.stringify({ branch: "vibe/flags", slug: "flags", operator: OPERATOR }));
  const keysFile = path.join(fixture.root, "flag-keys.json");
  const run = (script, args) => runNode(script, args, fixture.home);
  const recordKeys = (surfaces) => {
    writeFileSync(keysFile, JSON.stringify({ surfaces }));
    return run(SCRIPT, ["record", "--worktree", checkout, "--file", keysFile]);
  };
  const ask = (key) => {
    const question = run(SCRIPT, ["question", "--worktree", checkout, "--key", key]).json;
    run(QUESTIONS, ["ask", "--worktree", checkout, "--key", question.questionKey, "--question", question.question]);
    return question;
  };
  const answer = (questionKey, words) => run(QUESTIONS, ["answer", "--worktree", checkout, "--key", questionKey, "--answer", words]);
  const approve = (key, decision, words) =>
    run(SCRIPT, ["approve", "--worktree", checkout, "--key", key, "--decision", decision, "--answer", words]);
  const read = () => JSON.parse(readFileSync(record, "utf8"));
  return { checkout, run, recordKeys, ask, answer, approve, read };
}

test("no key is built without the person's yes to that exact question, and the yes records who and when", (t) => {
  const session = flagSession(t);
  const proposal = (readAt) => [surface([newKey({ readAt }), existingKey("labs-nav-section")])];

  const built = session.recordKeys(proposal(["packages/app/branches/components/branches-list.tsx"]));
  assert.equal(built.status, 1);
  assert.match(built.json.error, /`branches-list-v2` is read in packages\/app\/branches\/components\/branches-list\.tsx without the person's yes/);
  const recorded = session.recordKeys(proposal([]));
  assert.equal(recorded.status, 0);
  assert.deepEqual(recorded.json.pending.map((entry) => entry.key), ["branches-list-v2"]);
  assert.match(recorded.json.pending[0].next, /return NEEDS_FLAG_APPROVAL for `branches-list-v2`/);
  assert.equal(session.read().flagKeys.surfaces[0].keys[0].key, "branches-list-v2");

  const notAsked = session.approve("branches-list-v2", "approved", "yes");
  assert.equal(notAsked.status, 1);
  assert.match(notAsked.json.error, /The person was not asked about `branches-list-v2` in these words/);
  const question = session.ask("branches-list-v2");
  assert.match(question.next[1], /--decision approved only for an explicit yes/);
  const unanswered = session.approve("branches-list-v2", "approved", "yes");
  assert.equal(unanswered.status, 1);
  assert.match(unanswered.json.error, /No recorded answer under flag-approval:branches-list-v2:/);
  session.answer(question.questionKey, "Yes, add it");
  assert.equal(session.approve("branches-list-v2", "approved", "yes").status, 1);
  const approved = session.approve("branches-list-v2", "approved", "Yes, add it");
  assert.equal(approved.status, 0, approved.stderr);

  const approval = session.read().flagKeys.approvals["branches-list-v2"];
  assert.equal(approval.decision, "approved");
  assert.equal(approval.words, "Yes, add it");
  assert.deepEqual(approval.by, OPERATOR);
  assert.ok(approval.at);
  assert.equal(approval.question, question.question);
  assert.equal(session.recordKeys(proposal(["packages/app/branches/components/branches-list.tsx"])).status, 0);
  assert.deepEqual(session.run(SCRIPT, ["show", "--worktree", session.checkout]).json.problems, []);

  // The yes was for this stack only: one more key the work sits behind needs a new answer.
  const restacked = [surface([newKey({ readAt: ["packages/app/branches/components/branches-list.tsx"] }), existingKey("labs-nav-section"), existingKey("branches-shell")])];
  const stale = session.recordKeys(restacked);
  assert.equal(stale.status, 1);
  assert.match(stale.json.error, /without the person's yes for this proposal/);
  const proposed = [surface([newKey({ readAt: [] }), existingKey("labs-nav-section"), existingKey("branches-shell")])];
  assert.equal(session.recordKeys(proposed).status, 0);
  const asked = session.run(SCRIPT, ["question", "--worktree", session.checkout, "--key", "branches-list-v2"]).json;
  assert.notEqual(asked.questionKey, question.questionKey);
  assert.match(asked.question, /`branches-shell`, `labs-nav-section`/);
});

test("an approval never carries to another key, a no means no flag, and silence leaves it pending", (t) => {
  const session = flagSession(t);
  const onlyFirst = [surface([newKey({ readAt: [] })]), surface([newKey({ key: "tags-editor-v2", readAt: [] })], { surface: "Tags editor" })];
  assert.equal(session.recordKeys(onlyFirst).status, 0);
  const first = session.ask("branches-list-v2");
  session.answer(first.questionKey, "yes");
  assert.equal(session.approve("branches-list-v2", "approved", "yes").status, 0);
  const second = session.approve("tags-editor-v2", "approved", "yes");
  assert.equal(second.status, 1);
  assert.match(second.json.error, /not asked about `tags-editor-v2`/);
  const problems = flagKeyProblems(session.read());
  assert.deepEqual(problems.map((problem) => problem.split(";")[0]), [
    "`branches-list-v2` is approved but no file reads it",
    "`tags-editor-v2` has no approval from the person (pending)",
  ]);

  const declined = session.ask("tags-editor-v2");
  session.answer(declined.questionKey, "No, ship it to everyone");
  assert.equal(session.approve("tags-editor-v2", "declined", "No, ship it to everyone").status, 0);
  const kept = session.recordKeys(onlyFirst);
  assert.equal(kept.status, 1);
  assert.match(kept.json.error, /the person declined `tags-editor-v2`; remove it and build the change without a switch/);
});

test("approval needs the person running the session, and a prototype session records no keys", (t) => {
  const session = flagSession(t);
  assert.equal(session.recordKeys([surface([newKey({ readAt: [] })])]).status, 0);
  const question = session.ask("branches-list-v2");
  session.answer(question.questionKey, "yes");
  const record = session.read();
  delete record.operator;
  writeFileSync(path.join(git(session.checkout, ["rev-parse", "--absolute-git-dir"]), "vibe-session.json"), JSON.stringify(record));
  const refused = session.approve("branches-list-v2", "approved", "yes");
  assert.equal(refused.status, 1);
  assert.match(refused.json.error, /only the person running it can approve a flag key/);
  assert.deepEqual(flagKeyProblems({ branch: "prototype/x", slug: "x", operator: OPERATOR, createdAt: "2026-10-20T00:00:00Z" }), []);
});
