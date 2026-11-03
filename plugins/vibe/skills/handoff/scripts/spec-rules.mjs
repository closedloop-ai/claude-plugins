// A spec a human wrote is never the session's to move. An agent session once
// reworded a prototype spec's "reject ... moves beyond four levels" to
// "display-only" so it agreed with the code, though a written rule already
// forbade editing a spec to match an implementation; a self-approved plan and a
// ticket then repeated the new wording.
//
// A spec is a `*-spec.<ts|tsx|js|jsx|md|mdx>` file (a `.spec.` file is a
// test), or a Markdown file under a `prd`, `prds`, `spec` or `specs`
// directory. Any change to one the base already has needs the human source in
// the change log:
//   Spec change: <path>: <human name or operator ruling>, <YYYY-MM-DD>, <where>
// The session's own ticket, plan or change log is not a source.

import { escapeRegExp } from "./source-imports.mjs";

const SPEC_FILE = /(?:^|\/)[^/]+-spec\.(?:[cm]?[jt]sx?|mdx?)$|(?:^|\/)(?:prds?|specs?)\/(?:[^/]+\/)*[^/]+\.mdx?$/i;

/** Whether `file` is a spec under the rule above. */
export function isSpecFile(file) {
  return SPEC_FILE.test(file);
}

/** Blocks each change to an existing spec that records no dated human source. */
export function checkSpecChanges(files, changeLog, add) {
  for (const file of files.filter((entry) => entry.status !== "A" && isSpecFile(entry.oldPath ?? entry.path))) {
    if (file.added.length === 0 && file.removed.length === 0 && file.status !== "D") {
      continue;
    }
    const where = file.oldPath ?? file.path;
    const recorded = new RegExp(String.raw`^\s*(?:[-*]\s+)?Spec change:\s*${escapeRegExp(where)}:\s*(?:operator ruling|[A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)+),\s*\d{4}-\d{2}-\d{2},\s*\S`, "m");
    if (!recorded.test(changeLog)) {
      const line = file.removed[0]?.line ?? file.added[0]?.line ?? 1;
      add("spec-change", where, line, "changes a spec the base already has with no recorded human source; a spec that disagrees with the code is a finding to report, never one to edit", `restore the spec, or record \`Spec change: ${where}: <human name or operator ruling>, <YYYY-MM-DD>, <where they said it>\`; the session's own ticket, plan or change log is not a source`);
    }
  }
}
