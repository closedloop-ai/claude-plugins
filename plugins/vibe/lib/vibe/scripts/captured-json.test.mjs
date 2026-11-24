import assert from "node:assert/strict";
import test from "node:test";
import { capturedJson, capturedJsonDocuments } from "./captured-json.mjs";

test("AC-083 consumes complete ordered JSON documents and refuses trailing output", () => {
  assert.deepEqual(capturedJsonDocuments('{"key":"}"}[2]\nfalse 3 null "end"'), [{ key: "}" }, [2], false, 3, null, "end"]);
  assert.deepEqual(capturedJson(' [true, null] '), [true, null]);
  for (const malformed of ["", "[", "{}oops", '{"key":}', "true [}"]) {
    assert.throws(() => capturedJsonDocuments(malformed), /captured JSON/i);
  }
  assert.throws(() => capturedJson("{}{}"), /one JSON document/i);
});
