import { after, before } from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";

/** Provide the package-manager registry responses used in direct capability and host tests on minimal CI runners. */
export function installPnpmHelpFixture() {
  let fixture, previous;
  before(() => {
    fixture = makeHome("pnpm-help-fixture-");
    const program = path.join(fixture.root,"pnpm");
    writeFileSync(program,`#!/bin/sh
[ "$1" = help ] || exit 2
echo 'Version 11.20.0'
case "$2" in
  root) echo 'Usage: pnpm root';;
  verify|desktop:typecheck|typecheck) printf 'No results for "%s"\\n' "$2";;
  *) exit 2;;
esac
`,{mode:0o700});
    previous = process.env.PATH;
    process.env.PATH = fixture.root + path.delimiter + previous;
  });
  after(() => { process.env.PATH = previous; fixture.cleanup(); });
}
