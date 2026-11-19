import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

function grader(relative) {
  const source = readFileSync(path.join(root, relative), "utf8");
  const pattern = /^pattern: '(.+)'$/m.exec(source)?.[1]?.replaceAll("''", "'");
  assert.ok(pattern, relative);
  return new RegExp(pattern, /^flags: '?(.*)'?$/m.exec(source)?.[1] ?? "i");
}

const ruled = [
  {
    file: "pm-agent-docs-draft-blocked/graders/fix-removes-it.md",
    accepted: "blocking | agents/documents.mdx | drafted text escaped | evidence | Have the same writer restore the file to session-base",
    rejected: "blocking | agents/documents.mdx | drafted text escaped | evidence | keep the paragraph behind markers",
  },
  {
    file: "pm-is-engineer-next-step/graders/reply-names-next-step.md",
    accepted: "A_REPLY: I'm running that exact check once more now.",
    rejected: "A_REPLY: Ask an engineer what to do.",
  },
  {
    file: "pm-tooling-rerun-continues/graders/reply-keeps-moving.md",
    accepted: "REPLY: I'm running it once more. If it still won't run, I'll use a smaller version.",
    rejected: "REPLY: This needs an engineer.",
  },
  {
    file: "pm-review-dead-clear-control/graders/clear.md",
    accepted: "blocking | creation-owner-field.tsx:56 | callback ignores null | evidence | Don't render the Clear row when the field can't be cleared",
    rejected: "blocking | creation-owner-field.tsx:56 | callback ignores null | evidence | Keep Clear and document it",
  },
  {
    file: "exec-setup-check-block-first-reply/graders/setup-check-command.md",
    accepted: 'NEXT: node "/tmp/vibe/skills/vibe/scripts/plugin-version.mjs" check --runtime codex --closedloop connected --graph not-connected',
    rejected: 'NEXT: node "/tmp/vibe/skills/vibe/scripts/plugin-version.mjs" check --runtime codex --closedloop connected',
  },
];

for (const { file, accepted, rejected } of ruled) {
  test(`ISS-14224: ${file} accepts only its operator-ruled widening`, () => {
    const pattern = grader(file);
    assert.equal(pattern.test(accepted), true, `${file} rejected the ruled wording`);
    assert.equal(pattern.test(rejected), false, `${file} accepted a missing or contrary behavior`);
  });
}
