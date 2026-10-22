import assert from "node:assert/strict";
import test from "node:test";
import { portableSurfaceChecker } from "../../vibe/scripts/test-fixtures.mjs";
import { isPortableSurfaceAllowlistEdit } from "./prototype-allowlist.mjs";

const EXISTING = "@repo/app/shared/components/existing-preview";
const ADDED = "@repo/app/board/components/board-preview";

test("only additive exact modules with real files extend the canonical initializer", () => {
  const base = portableSurfaceChecker([EXISTING]);
  const exists = (specifier) => specifier === ADDED;
  assert.equal(isPortableSurfaceAllowlistEdit(base, portableSurfaceChecker([EXISTING, ADDED]), exists), true);
  assert.equal(isPortableSurfaceAllowlistEdit(base, portableSurfaceChecker([ADDED]), exists), false);
  for (const specifier of ["@repo/app/*", "@repo/app", "@repo/app/board/hooks/use-board", "@repo/app/missing"] ) {
    assert.equal(isPortableSurfaceAllowlistEdit(base, portableSurfaceChecker([EXISTING, specifier]), exists), false, specifier);
  }
  const widened = portableSurfaceChecker([EXISTING, ADDED]).replace(".has(specifier)", ".has(specifier) || true");
  assert.equal(isPortableSurfaceAllowlistEdit(base, widened, exists), false);
  assert.equal(isPortableSurfaceAllowlistEdit(base, portableSurfaceChecker([EXISTING, ADDED, ADDED]), exists), false);
  const priorDuplicates = portableSurfaceChecker([EXISTING, EXISTING]);
  assert.equal(isPortableSurfaceAllowlistEdit(priorDuplicates, portableSurfaceChecker([EXISTING, EXISTING, ADDED]), exists), true);
  assert.equal(isPortableSurfaceAllowlistEdit(base.trimEnd(), portableSurfaceChecker([EXISTING, ADDED]), exists), true);
});
