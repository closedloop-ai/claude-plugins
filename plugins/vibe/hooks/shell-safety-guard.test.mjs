import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { credentialProblem, forcePushProblem } from "./shell-safety-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "shell-safety-guard.mjs");

test("credential workarounds are refused at the first auth failure", () => {
  const refused = [
    "GH_TOKEN=$token DOCKER_CONFIG=$(mktemp -d) docker pull ghcr.io/acme/app:sha",
    "printf '%s' \"$GH_TOKEN\" | docker login ghcr.io -u operator --password-stdin",
    "echo '{\"auths\":{\"ghcr.io\":{\"auth\":\"'$TOKEN'\"}}}' > /tmp/config.json",
    "ssh primary 'DOCKER_CONFIG=/tmp/evidence GITHUB_TOKEN=$GITHUB_TOKEN docker pull ghcr.io/acme/app:sha'",
  ];
  for (const command of refused) assert.match(credentialProblem(command) ?? "", /credential/i, command);
  for (const command of ["gh run view 123 --log", "gh api repos/acme/app/actions/runs/123", "docker pull alpine:latest", "DOCKER_CONFIG=/tmp/test docker version"]) {
    assert.equal(credentialProblem(command), null, command);
  }
});

test("force push is refused for every remote, including a remote laptop and proof refs", () => {
  const refused = [
    "git push -f origin fix/work",
    "git push --force-with-lease fork HEAD:fix/work",
    "ssh primary 'git -C repo push --force local HEAD:proof/abc-1'",
    "git push scratch +HEAD:refs/heads/proof/abc-1",
  ];
  for (const command of refused) assert.match(forcePushProblem(command) ?? "", /force.push/i, command);
  assert.equal(forcePushProblem("git push primary HEAD:proof/abc-2"), null);
  assert.equal(forcePushProblem("git push origin fix/work"), null);
});

test("the PreToolUse hook denies unsafe Bash and is registered", () => {
  const run = (command) => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8",
  });
  for (const command of ["GH_TOKEN=$token DOCKER_CONFIG=/tmp/x docker pull ghcr.io/acme/app:sha", "git push -f primary HEAD:proof/a-1"]) {
    const result = run(command);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal(run("gh run view 123 --log").stdout, "");
  assert.ok(readFileSync(path.join(HERE, "hooks.json"), "utf8").includes("hooks/shell-safety-guard.mjs"));
});
