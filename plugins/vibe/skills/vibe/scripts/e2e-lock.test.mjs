import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUSY_EXIT, DUPLICATE_EXIT, captureOwnedDockerResources, composeProjectFor, defaultLockDir, readHolder, release, removeOwnedDockerResources, runningForeignCompose, sameWorktreeEntry, tryAcquire } from "./e2e-lock.mjs";
import { sourceIdentity } from './tested-head.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e-lock.mjs");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibe-e2e-lock-")));
after(() => rmSync(root, { recursive: true, force: true }));
// `run` tests a named commit of a clean worktree, so every run happens in a repository at a known HEAD.
const commitAt = (dir) => {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: "2026-10-22T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-22T00:00:00Z" };
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).stdout.trim();
  git("init", "--quiet", "--initial-branch=main");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  return git("rev-parse", "HEAD");
};
const defaultWorktree = path.join(root, "default-worktree");
mkdirSync(defaultWorktree);
const SHA = commitAt(defaultWorktree);
process.chdir(defaultWorktree);

const owner = (pid, token) => ({ pid, token, cwd: root, command: "e2e", startedAt: "2026-10-19T00:00:00.000Z" });
// A pid that cannot exist: above the macOS and Linux pid ceilings.
const DEAD_PID = 99_999_999;
const FULL_CONTAINER_ID = "a".repeat(64);
const FULL_NETWORK_ID = "c".repeat(64);

test("e2e lock and fleet helpers share the raw process identity primitive", () => {
  const e2e = readFileSync(SCRIPT, "utf8");
  const helpers = readFileSync(path.resolve(path.dirname(SCRIPT), "../../fleet-orchestrator/scripts/helpers.mjs"), "utf8");
  const session = readFileSync(path.join(path.dirname(SCRIPT), "session-processes.mjs"), "utf8");
  const shared = readFileSync(path.resolve(path.dirname(SCRIPT), "../../../shared/process-identity.mjs"), "utf8");
  assert.match(shared, /export function readProcessIdentity\(/);
  assert.match(e2e, /import \{ readProcessIdentity \} from "\.\.\/\.\.\/\.\.\/shared\/process-identity\.mjs"/);
  assert.doesNotMatch(e2e, /function (?:processIdentity|readProcessIdentity)\(/);
  assert.match(helpers, /import \{ readProcessIdentity \} from "\.\.\/\.\.\/\.\.\/shared\/process-identity\.mjs"/);
  assert.match(helpers, /export const readIdentity = readProcessIdentity/);
  assert.doesNotMatch(helpers, /function readIdentity\(/);
  assert.match(session, /\nfunction processIdentity\(/);
  assert.doesNotMatch(session, /export function processIdentity\(/);
});

test("Docker inspect read failures retain an owned resource; only exact absence counts gone", () => {
  const record = { project: null, containers: [{ id: FULL_CONTAINER_ID, created: "2026-10-29T00:00:00Z", project: "qa-owned" }], volumes: [], networks: [] };
  let removed = false;
  const refused = ([, action]) => action === "inspect"
    ? { status: 1, stderr: "permission denied while connecting to daemon" }
    : (removed = true, { status: 0 });
  assert.throws(() => removeOwnedDockerResources(record, { run: refused }), /Docker .*inspect failed/);
  assert.equal(removed, false);
  const absent = ([, action]) => action === "inspect"
    ? { status: 1, stdout: "[]\n", stderr: `Error response from daemon: No such container: ${FULL_CONTAINER_ID}` }
    : (removed = true, { status: 0 });
  assert.deepEqual(removeOwnedDockerResources(record, { run: absent }).removed, []);
  assert.equal(removed, false);
});

test("Docker project capture requests full network IDs before comparing inspect identity", () => {
  const project = "vibe-e2e-test";
  const fullNetworkId = "b".repeat(64);
  const shortNetworkId = fullNetworkId.slice(0, 12);
  const lists = [];
  const run = ([kind, action, ...args]) => {
    if (action === "ls") {
      lists.push([kind, ...args]);
      if (kind !== "network") return { status: 0, stdout: "" };
      return { status: 0, stdout: args.includes("--no-trunc") ? fullNetworkId : shortNetworkId };
    }
    if (kind === "network" && action === "inspect") {
      return { status: 0, stdout: JSON.stringify([{ Id: fullNetworkId, Created: "2026-10-29T00:00:00Z",
        Labels: { "com.docker.compose.project": project } }]) };
    }
    throw new Error(`unexpected Docker action ${kind} ${action}`);
  };
  const record = captureOwnedDockerResources({ project }, { run });
  assert.deepEqual(record.networks.map((entry) => entry.id), [fullNetworkId]);
  assert.ok(lists.find(([kind]) => kind === "container").includes("--no-trunc"));
  assert.ok(lists.find(([kind]) => kind === "network").includes("--no-trunc"));
  assert.ok(!lists.find(([kind]) => kind === "volume").includes("--no-trunc"), "Docker volume ls has no no-trunc option");
});

test("Docker 29 volume and network not-found replies prove exact absence", () => {
  const record = {
    project: null,
    containers: [],
    volumes: [{ id: "owned-volume", created: "2026-10-29T00:00:00Z", project: "qa-owned" }],
    networks: [{ id: FULL_NETWORK_ID, created: "2026-10-29T00:00:01Z", project: "qa-owned" }],
  };
  const absent = ([kind, action, id]) => {
    assert.equal(action, "inspect");
    if (kind === "volume") return { status: 1, stdout: "[]\n",
      stderr: `Error response from daemon: get ${id}: no such volume` };
    if (kind === "network") return { status: 1, stdout: "[]\n",
      stderr: `Error response from daemon: network ${id} not found` };
    throw new Error(`unexpected Docker kind ${kind}`);
  };
  assert.deepEqual(removeOwnedDockerResources(record, { run: absent }).removed, []);
  assert.throws(() => removeOwnedDockerResources(record, { run: ([kind, action, id]) => ({ status: 1,
    stderr: kind === "volume" ? `Error response from daemon: get other: no such volume`
      : `Error response from daemon: network ${id} permission denied` }) }), /Docker .*inspect failed/);
});

test("Docker capture refuses container prefixes, resolved ID mismatch, missing ownership and invalid birth", () => {
  const inspect = (value) => ([, action]) => action === "inspect"
    ? { status: 0, stdout: JSON.stringify([value]) } : { status: 0, stdout: "" };
  const value = { Id: FULL_CONTAINER_ID, Created: "2026-10-29T00:00:00Z",
    Config: { Labels: { "com.docker.compose.project": "qa-owned" } } };
  const capture = (id, body) => captureOwnedDockerResources({ containers: [id], volumes: [], networks: [] }, { run: inspect(body) });
  assert.throws(() => capture(FULL_CONTAINER_ID.slice(0, 12), value), /full container ID/);
  assert.throws(() => capture("b".repeat(64), value), /changed identity|resolved ID/);
  assert.throws(() => capture(FULL_CONTAINER_ID, { ...value, Config: { Labels: {} } }), /project ownership/);
  assert.throws(() => capture(FULL_CONTAINER_ID, { ...value, Created: "not-a-date" }), /creation witness/);
});

test("recorded Docker resources are removed with stopped containers, volumes and networks", () => {
  const project = "vibe-e2e-test";
  const resources = new Map([
    [`container:${FULL_CONTAINER_ID}`, { Id: FULL_CONTAINER_ID, Created: "2026-10-29T00:00:00Z", Config: { Labels: { "com.docker.compose.project": project } } }],
    ["volume:v1", { Name: "v1", CreatedAt: "2026-10-29T00:00:01Z", Labels: { "com.docker.compose.project": project } }],
    [`network:${FULL_NETWORK_ID}`, { Id: FULL_NETWORK_ID, Created: "2026-10-29T00:00:02Z", Labels: { "com.docker.compose.project": project } }],
  ]);
  const removed = [];
  const run = ([kind, action, ...args]) => {
    if (action === "ls") return { status: 0, stdout: [...resources.keys()].filter((key) => key.startsWith(`${kind}:`)).map((key) => key.split(":")[1]).join("\n") };
    const id = args.at(-1);
    if (action === "inspect") {
      if (resources.has(`${kind}:${id}`)) return { status: 0, stdout: JSON.stringify([resources.get(`${kind}:${id}`)]) };
      const stderr = kind === "container" ? `Error response from daemon: No such container: ${id}`
        : kind === "volume" ? `Error response from daemon: get ${id}: no such volume`
          : `Error response from daemon: network ${id} not found`;
      return { status: 1, stdout: "[]\n", stderr };
    }
    if (action === "rm") {
      removed.push(`${kind}:${id}`);
      resources.delete(`${kind}:${id}`);
      return { status: 0, stdout: "" };
    }
    throw new Error(`unexpected Docker action ${kind} ${action}`);
  };
  const record = captureOwnedDockerResources({ project }, { run });
  assert.deepEqual(record.containers.map((entry) => entry.id), [FULL_CONTAINER_ID]);
  assert.deepEqual(removeOwnedDockerResources(record, { run }).removed.map((entry) => entry.id), [FULL_CONTAINER_ID, "v1", FULL_NETWORK_ID]);
  assert.deepEqual(removed, [`container:${FULL_CONTAINER_ID}`, "volume:v1", `network:${FULL_NETWORK_ID}`]);
});

test("a changed Docker creation witness or foreign label refuses all removal", () => {
  const project = "vibe-e2e-test";
  const resource = { Id: FULL_CONTAINER_ID, Created: "2026-10-29T00:00:00Z", Config: { Labels: { "com.docker.compose.project": project } } };
  let calls = 0;
  const run = ([kind, action]) => {
    if (action === "inspect") return { status: 0, stdout: JSON.stringify([resource]) };
    if (action === "rm") calls += 1;
    return { status: 0, stdout: "" };
  };
  const record = captureOwnedDockerResources({ project, containers: [FULL_CONTAINER_ID], volumes: [], networks: [] }, { run });
  resource.Created = "2026-10-29T00:00:01Z";
  assert.throws(() => removeOwnedDockerResources(record, { run }), /changed identity/);
  assert.equal(calls, 0);
  resource.Created = "2026-10-29T00:00:00Z";
  resource.Config.Labels["com.docker.compose.project"] = "foreign";
  assert.throws(() => removeOwnedDockerResources(record, { run }), /changed identity/);
  assert.equal(calls, 0);
});

test("a new unrecorded resource in an owned project is left for an owner to inspect", () => {
  let removals = 0;
  const project = "vibe-e2e-test";
  const run = ([kind, action]) => {
    if (action === "ls") return { status: 0, stdout: kind === "container" ? FULL_CONTAINER_ID : "" };
    if (action === "inspect") return { status: 0, stdout: JSON.stringify([{ Id: FULL_CONTAINER_ID, Created: "2026-10-29T00:00:00Z",
      Config: { Labels: { "com.docker.compose.project": project } } }]) };
    if (action === "rm") removals += 1;
    return { status: 0, stdout: "" };
  };
  assert.throws(() => removeOwnedDockerResources({ project, containers: [], volumes: [], networks: [] }, { run }), /not recorded/);
  assert.equal(removals, 0);
});

test("a run removes its fake Docker project even when the command fails", () => {
  const dir = path.join(root, "owned-docker-fixture");
  mkdirSync(dir);
  const docker = path.join(dir, "docker");
  writeFileSync(docker, `#!/bin/sh
dir=${JSON.stringify(dir)}
for arg in "$@"; do last="$arg"; done
case "$1 $2" in
  "version ") exit 0 ;;
  "container ls") [ -f "$dir/container" ] && echo ${FULL_CONTAINER_ID}; exit 0 ;;
  "volume ls") [ -f "$dir/volume" ] && echo v1; exit 0 ;;
  "network ls") [ -f "$dir/network" ] && echo ${FULL_NETWORK_ID}; exit 0 ;;
  "container inspect") [ -f "$dir/container" ] || { printf 'Error response from daemon: No such container: %s\n' "$last" >&2; exit 1; }; printf '[{"Id":"${FULL_CONTAINER_ID}","Created":"2026-10-29T00:00:00Z","Config":{"Labels":{"com.docker.compose.project":"%s"}}}]\n' "$(cat "$dir/project")"; exit 0 ;;
  "volume inspect") [ -f "$dir/volume" ] || { printf 'Error response from daemon: get %s: no such volume\n' "$last" >&2; exit 1; }; printf '[{"Name":"v1","CreatedAt":"2026-10-29T00:00:00Z","Labels":{"com.docker.compose.project":"%s"}}]\n' "$(cat "$dir/project")"; exit 0 ;;
  "network inspect") [ -f "$dir/network" ] || { printf 'Error response from daemon: network %s not found\n' "$last" >&2; exit 1; }; printf '[{"Id":"${FULL_NETWORK_ID}","Created":"2026-10-29T00:00:00Z","Labels":{"com.docker.compose.project":"%s"}}]\n' "$(cat "$dir/project")"; exit 0 ;;
  "container rm") rm "$dir/container"; exit 0 ;;
  "volume rm") rm "$dir/volume"; exit 0 ;;
  "network rm") rm "$dir/network"; exit 0 ;;
esac
exit 9
`);
  chmodSync(docker, 0o700);
  const create = `const fs=require('node:fs');const d=${JSON.stringify(dir)};fs.writeFileSync(d+'/project',process.env.COMPOSE_PROJECT_NAME);for(const x of ['container','volume','network'])fs.writeFileSync(d+'/'+x,'created');const p=fs.readdirSync(d).find(x=>x.startsWith('e2e-cleanup-'));fs.writeFileSync(d+'/owner.json',JSON.stringify(JSON.parse(fs.readFileSync(d+'/'+p)).owner));process.exit(7)`;
  const env = { ...process.env, VIBE_E2E_DOCKER: docker };
  Reflect.deleteProperty(env, "COMPOSE_PROJECT_NAME");
  Reflect.deleteProperty(env, "VIBE_E2E_FOREIGN_COMPOSE");
  const result = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--owner", "writer-a", "--ticket", "ticket-one",
    "--lock-dir", path.join(dir, "lock"), process.execPath, "-e", create],
    { encoding: "utf8", env });
  assert.equal(result.status, 7, result.stderr);
  const savedOwner = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8"));
  assert.equal(savedOwner.name, "writer-a");
  assert.equal(savedOwner.ticket, "ticket-one");
  for (const kind of ["container", "volume", "network"]) assert.equal(existsSync(path.join(dir, kind)), false, kind);
});

test("the lock is one folder per machine, under the vibe home", () => {
  assert.equal(defaultLockDir("/home/someone"), path.join("/home/someone", ".codex", "vibe", "locks", "e2e-stack"));
});

test("a second session cannot take the stack while the first holder is alive", () => {
  const lockDir = path.join(root, "held");
  assert.equal(tryAcquire(lockDir, owner(process.pid, "first")).acquired, true);
  const second = tryAcquire(lockDir, owner(process.pid, "second"));
  assert.equal(second.acquired, false);
  assert.equal(second.holder.token, "first");
  release(lockDir, owner(process.pid, "second"));
  assert.equal(readHolder(lockDir).token, "first", "a non-holder cannot release");
  release(lockDir, owner(process.pid, "first"));
  assert.equal(existsSync(lockDir), false);
});

test("a lock left by a process that no longer exists is taken over", () => {
  const lockDir = path.join(root, "stale");
  assert.equal(tryAcquire(lockDir, owner(DEAD_PID, "crashed")).acquired, true);
  const next = tryAcquire(lockDir, owner(process.pid, "next"));
  assert.equal(next.acquired, true);
  assert.equal(readHolder(lockDir).token, "next");
});

test("a lock folder whose owner is still writing its record is not taken; an old ownerless one is", () => {
  const lockDir = path.join(root, "ownerless");
  mkdirSync(lockDir, { recursive: true });
  assert.equal(tryAcquire(lockDir, owner(process.pid, "eager")).acquired, false);
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(lockDir, old, old);
  assert.equal(tryAcquire(lockDir, owner(process.pid, "eager")).acquired, true);
});

test("run serializes two commands on one stack and releases the lock after each", async () => {
  const lockDir = path.join(root, "serial");
  const marks = path.join(root, "marks.log");
  const step = (name) => [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, process.execPath, "-e",
    `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(marks)},"${name}-start\\n");` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(marks)},"${name}-end\\n")},1500)`];
  const first = spawn(process.execPath, step("a"), { stdio: "ignore" });
  const firstStarted = await waitFor(() => existsSync(marks));
  assert.ok(firstStarted);
  const otherWorktree = path.join(root, "wt-serial");
  mkdirSync(otherWorktree);
  assert.equal(commitAt(otherWorktree), SHA);
  const second = spawnSync(process.execPath, step("b"), { encoding: "utf8", timeout: 60_000, cwd: otherWorktree });
  assert.equal(second.status, 0, second.stderr);
  await new Promise((resolve) => first.once("close", resolve));
  assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), ["a-start", "a-end", "b-start", "b-end"]);
  assert.equal(existsSync(lockDir), false);
});

test("run keeps the command's exit code and runs nothing when the stack stays busy", () => {
  const lockDir = path.join(root, "busy");
  const code = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, process.execPath, "-e", "process.exit(4)"]);
  assert.equal(code.status, 4);
  assert.equal(tryAcquire(lockDir, { ...owner(process.pid, "holder"), worktree: path.join(root, "another-worktree") }).acquired, true);
  const marker = path.join(root, "should-not-exist");
  const busy = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir,
    process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], { encoding: "utf8" });
  assert.equal(busy.status, BUSY_EXIT);
  assert.equal(JSON.parse(busy.stdout).holder.token, "holder");
  assert.equal(existsSync(marker), false);
  const status = spawnSync(process.execPath, [SCRIPT, "status", "--lock-dir", lockDir], { encoding: "utf8" });
  assert.equal(JSON.parse(status.stdout).status, "held");
});

test("one session takes one entry: a second run from the same worktree is refused while the first holds or waits", () => {
  const lockDir = path.join(root, "per-head");
  mkdirSync(path.join(root, "wt-a"), { recursive: true });
  const worktree = realpathSync(path.join(root, "wt-a"));
  assert.equal(commitAt(worktree), SHA);
  assert.equal(tryAcquire(lockDir, { ...owner(process.pid, "first"), worktree }).acquired, true);
  assert.equal(sameWorktreeEntry(lockDir, worktree).token, "first");
  assert.equal(sameWorktreeEntry(lockDir, path.join(root, "wt-b")), null);
  const marker = path.join(root, "per-spec-ran");
  const second = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir,
    process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], { encoding: "utf8", cwd: worktree });
  assert.equal(second.status, DUPLICATE_EXIT);
  assert.match(JSON.parse(second.stdout).reason, /one run per head/);
  assert.equal(existsSync(marker), false);
  release(lockDir, { ...owner(process.pid, "first"), worktree });
  mkdirSync(`${lockDir}.waiters`, { recursive: true });
  writeFileSync(path.join(`${lockDir}.waiters`, "w.json"), JSON.stringify({ ...owner(process.pid, "waiting"), worktree }));
  assert.equal(sameWorktreeEntry(lockDir, worktree).token, "waiting");
  writeFileSync(path.join(`${lockDir}.waiters`, "w.json"), JSON.stringify({ ...owner(DEAD_PID, "waiting"), worktree }));
  assert.equal(sameWorktreeEntry(lockDir, worktree), null);
});

test("options after the command belong to the command, not the lock", () => {
  const lockDir = path.join(root, "passthrough");
  const echo = path.join(root, "echo-args.cjs");
  writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const result = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, process.execPath, echo,
    "--lock-dir", "theirs", "--wait-seconds", "9"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["--lock-dir", "theirs", "--wait-seconds", "9"]);
  assert.equal(existsSync(lockDir), false);
});

test("a missing command is refused with usage", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "run"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage/);
});

test("each run gets its own compose project unless the caller set one", () => {
  const lockDir = path.join(root, "compose-own");
  const print = [process.execPath, "-e", "process.stdout.write(process.env.COMPOSE_PROJECT_NAME)"];
  const env = { ...process.env };
  Reflect.deleteProperty(env, "COMPOSE_PROJECT_NAME");
  Reflect.deleteProperty(env, "VIBE_E2E_FOREIGN_COMPOSE");
  const first = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, ...print], { encoding: "utf8", env });
  const second = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, ...print], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^vibe-e2e-[0-9a-f]{8}$/);
  assert.notEqual(first.stdout, second.stdout, "two runs never share a project, so one teardown cannot remove the other's stack");
  assert.match(first.stderr, new RegExp(`compose project ${first.stdout}`));
  const kept = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--lock-dir", lockDir, ...print], { encoding: "utf8", env: { ...env, COMPOSE_PROJECT_NAME: "callers-own" } });
  assert.equal(kept.stdout, "callers-own");
  assert.equal(composeProjectFor({}, "0123abcd-ef45-6789"), "vibe-e2e-0123abcd");
});

test("a stack started outside the lock on a named compose project keeps the stack busy; no Docker checks nothing", () => {
  const lockDir = path.join(root, "compose-foreign");
  const listing = path.join(root, "compose-ls.json");
  const docker = path.join(root, "fake-docker");
  writeFileSync(docker, `#!/bin/sh\n[ "$1 $2 $3 $4" = "compose ls --format json" ] || exit 9\ncat "${listing}"\n`);
  chmodSync(docker, 0o755);
  writeFileSync(listing, JSON.stringify([{ Name: "fixed-e2e", Status: "running(5)" }, { Name: "other", Status: "exited(1)" }]));
  assert.equal(runningForeignCompose(["other", "fixed-e2e"], docker), "fixed-e2e");
  assert.equal(runningForeignCompose(["other"], docker), null, "an exited project is not a running stack");
  assert.equal(runningForeignCompose(["fixed-e2e"], path.join(root, "no-docker")), null);
  const marker = path.join(root, "foreign-ran");
  const env = { ...process.env, VIBE_E2E_DOCKER: docker };
  Reflect.deleteProperty(env, "VIBE_E2E_FOREIGN_COMPOSE");
  const command = [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`];
  const busy = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir, "--foreign-compose", "fixed-e2e", ...command], { encoding: "utf8", env });
  assert.equal(busy.status, BUSY_EXIT, busy.stderr);
  assert.deepEqual(JSON.parse(busy.stdout).holder, { composeProject: "fixed-e2e" });
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(lockDir), false, "the lock is released while the foreign stack runs");
  const fromEnv = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir, ...command], { encoding: "utf8", env: { ...env, VIBE_E2E_FOREIGN_COMPOSE: "x, fixed-e2e" } });
  assert.equal(fromEnv.status, BUSY_EXIT);
  writeFileSync(listing, "[]");
  const free = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir, "--foreign-compose", "fixed-e2e", ...command], { encoding: "utf8", env });
  assert.equal(free.status, 0, free.stderr);
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  const noDocker = spawnSync(process.execPath, [SCRIPT, "run", "--head", SHA, "--wait-seconds", "0", "--lock-dir", lockDir, "--foreign-compose", "fixed-e2e", ...command],
    { encoding: "utf8", env: { ...env, VIBE_E2E_DOCKER: path.join(root, "no-docker") } });
  assert.equal(noDocker.status, 0, noDocker.stderr);
  assert.equal(existsSync(marker), true);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("run tests only the named commit of a clean worktree and names it (23/23 reported for an untested PR)", () => {
  const lockDir = path.join(root, "tested-head");
  const wt = path.join(root, "wt-head");
  mkdirSync(wt);
  commitAt(wt);
  writeFileSync(path.join(wt, "tracked.txt"), "one\n");
  spawnSync("git", ["-C", wt, "add", "tracked.txt"]);
  spawnSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "pr head"]);
  const head = spawnSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const run = (sha, ...command) => spawnSync(process.execPath, [SCRIPT, "run", "--head", sha, "--lock-dir", lockDir, ...command], { encoding: "utf8", cwd: wt });
  const ok = [process.execPath, "-e", "0"];
  const stale = run(SHA, ...ok);
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /^HEAD-MISMATCH /);
  writeFileSync(path.join(wt, "tracked.txt"), "leftover\n");
  const dirty = run(head, ...ok);
  assert.equal(dirty.status, 0, dirty.stderr);
  assert.match(dirty.stderr, /diffSha256.*[a-f0-9]{64}/);
  const mutation = run(head, process.execPath, '-e', "require('fs').writeFileSync('tracked.txt','edited during run')");
  assert.equal(mutation.status, 1, mutation.stderr);
  assert.match(mutation.stderr, /SOURCE-MOVED/);
  spawnSync("git", ["-C", wt, "checkout", "--quiet", "--", "tracked.txt"]);
  const clean = run(head.slice(0, 8), ...ok);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stderr, new RegExp(`^e2e-lock: testing ${head}$`, "m"));
  const moved = run(head, "git", "checkout", "--quiet", SHA);
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /^HEAD-MOVED /m);
});

test('dirty headless-harness boundary carries a source hash even when prepush emits only HEAD', () => {
  const wt = path.join(root, 'dirty-harness-boundary');
  mkdirSync(wt);
  const head = commitAt(wt);
  writeFileSync(path.join(wt, 'candidate.txt'), 'uncommitted candidate');
  const source = sourceIdentity(wt);
  const lock = path.join(root, 'dirty-harness-lock');
  // Model only prepush's evidence boundary, never its Docker/Playwright/Electron execution.
  const command = [process.execPath, '-e', "process.stdout.write(require('child_process').execFileSync('git',['rev-parse','HEAD']))"];
  const run = hash => spawnSync(process.execPath, [SCRIPT, 'run', '--head', head, '--source-hash', hash, '--lock-dir', lock, ...command], {
    cwd: wt, encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: 'fixture-source-identity' },
  });
  const accepted = run(source.treeSha256);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.trim(), head, 'the legacy producer still emits only HEAD');
  const receipts = readdirSync(path.join(wt, '.git/vibe-e2e-results'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(readFileSync(path.join(wt, '.git/vibe-e2e-results', receipts[0]), 'utf8'));
  assert.deepEqual(receipt.source, source, 'the owner receipt identifies the dirty inputs that really ran');
  assert.equal(receipt.exitCode, 0);
  const stale = run('0'.repeat(64));
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /SOURCE-HASH-MISMATCH/);
});

test("a --no-build run needs images built from the head it tests in the same worktree (stale-image reruns, ISS-13067)", () => {
  const lockDir = path.join(root, "image-head", "e2e-stack");
  const wt = path.join(root, "wt-images");
  const other = path.join(root, "wt-images-other");
  mkdirSync(wt);
  mkdirSync(other);
  const first = commitAt(wt);
  commitAt(other);
  const env = { ...process.env, COMPOSE_PROJECT_NAME: "cl-e2e-fixture" };
  Reflect.deleteProperty(env, "VIBE_E2E_FOREIGN_COMPOSE");
  const run = (cwd, sha, ...flags) => spawnSync(process.execPath, [SCRIPT, "run", "--head", sha, "--lock-dir", lockDir,
    process.execPath, "-e", "0", "--", ...flags], { encoding: "utf8", cwd, env });
  assert.match(run(wt, first, "--no-build").stderr, /STALE-IMAGES no recorded build/);
  assert.equal(run(wt, first).status, 0, "a build records its images");
  assert.equal(run(wt, first, "--no-build").status, 0, "reuse at the same head and worktree");
  const elsewhere = run(other, spawnSync("git", ["-C", other, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), "--no-build");
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stderr, /STALE-IMAGES .*(built from|built in)/);
  spawnSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "--allow-empty", "-m", "fix"]);
  const fix = spawnSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const reused = run(wt, fix, "--no-build");
  assert.equal(reused.status, 1);
  assert.match(reused.stderr, new RegExp(`STALE-IMAGES cl-e2e-fixture's images were built from ${first.slice(0, 12)}`));
  assert.equal(run(wt, fix).status, 0);
  assert.equal(run(wt, fix, "--no-build").status, 0);
});
