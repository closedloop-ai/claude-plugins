import assert from "node:assert/strict";
import test from "node:test";
import { isShrinkOnlyAllowlistEdit } from "./allowlist-shrink.mjs";

const A = { rule: "r1", file: "a.tsx", fingerprint: "a.tsx", count: 2, reason: "seeded" };
const B = { rule: "r2", file: "b.tsx", fingerprint: "b.tsx", count: 1, reason: "seeded" };
const text = (entries, registeredRules = ["r1", "r2"]) => JSON.stringify({ registeredRules, entries });

test("removing entries or lowering a count is a shrink", () => {
  assert.equal(isShrinkOnlyAllowlistEdit(text([A, B]), text([A])), true);
  assert.equal(isShrinkOnlyAllowlistEdit(text([A, B]), text([])), true);
  assert.equal(isShrinkOnlyAllowlistEdit(text([A, B]), text([{ ...A, count: 1 }, B])), true);
  assert.equal(isShrinkOnlyAllowlistEdit(text([B, A]), text([A, B])), true);
});

test("growing, adding, editing, duplicating, or touching other fields is not", () => {
  const cases = [
    text([{ ...A, count: 3 }, B]),
    text([{ ...A, count: 0 }, B]),
    text([A, B, { ...B, file: "c.tsx", fingerprint: "c.tsx" }]),
    text([A, A]),
    text([{ ...A, reason: "changed" }]),
    text([{ ...A, extra: true }]),
    text([A], ["r1"]),
    JSON.stringify({ registeredRules: ["r1", "r2"], entries: [A], other: 1 }),
    "not json",
    JSON.stringify({ entries: "nope" }),
  ];
  for (const current of cases) {
    assert.equal(isShrinkOnlyAllowlistEdit(text([A, B]), current), false, current);
  }
  assert.equal(isShrinkOnlyAllowlistEdit("not json", text([])), false);
});
