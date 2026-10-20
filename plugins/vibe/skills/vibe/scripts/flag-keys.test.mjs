import assert from "node:assert/strict";
import test from "node:test";
import { listedFlagKeys, renderFlagKeys, validateFlagKeys } from "./flag-keys.mjs";

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

test("the ticket block lists every key per surface with its value in the person's snapshot", () => {
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
    "| Surface | Hosts | Key | Origin | In this snapshot |",
    "|---|---|---|---|---|",
    "| Branches list | Desktop, web | `branches-list-v2` | new key | not in snapshot |",
    "| Branches list | Desktop, web | `labs-nav-section` | existing key | true |",
    "| Tags editor | web | none | - | - |",
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
    keys: [{ key: "branches-list-v2", origin: "new" }, { key: "labs-nav-section", origin: "existing" }],
  }]);
});
