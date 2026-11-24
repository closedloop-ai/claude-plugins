import assert from "node:assert/strict";
import test from "node:test";
import { run } from "./diff-rules-test-fixture.mjs";

test("AC-26 the diff gate classifies a pager and a story-support file as non-composers, so neither needs the shared owner", (t) => {
  const component = "packages/design-system/components/ui/filter-popover.tsx";
  const artifacts = "packages/app/shared/components/generic-artifact-surface/artifact-list-shell-sections.tsx";
  const projects = "packages/app/projects/components/project-list.tsx";
  const uses = (name) => 'import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";\nexport const ' + name + ' = () => <FilterPopover />;\n';
  const base = { [component]: "export function FilterPopover() { return null; }\n", [artifacts]: uses("ArtifactToolbar"), [projects]: uses("ProjectList") };
  const owners = (head) => run(t, { base, head }).blocking.filter((finding) => finding.rule === "shared-capability-owner").map((finding) => finding.file);
  const page = "packages/app/agents/components/sessions/sessions-list-toolbar-v2.tsx";
  assert.deepEqual(owners({ [page]: uses("SessionsToolbar") }), [page], "a page-level toolbar is a composer");
  assert.deepEqual(owners({ "packages/app/shared/pager.tsx": uses("Pager") }), [], "a pager is not a page composer");
  assert.deepEqual(owners({ "apps/storybook/stories/filter-list.tsx": uses("FilterListFixture") }), [], "a story-support file is exempt");
});
