import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkCloudSetup } from "./cloud-environment.mjs";
import { CLOUD_CAPABILITIES_COMMAND } from "./cloud-check-command.mjs";
import { confirmCloudEnvironment, recordRuntimeFromValidation, measuredSetupTools } from "./cloud-validation-environment.mjs";
import { PACKAGE_REPAIR, repairHostPackages } from "./cloud-validation-host.mjs";
import { makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";

test("AC-102 check requires current measured account, environment and all five tools", (t) => {
  const f = makeHome("vibe-cloud-setup-");
  t.after(f.cleanup);
  const pin = { accountUuid: "a0a01111-1111-4111-a111-111111111111", environmentId: "env_Fixture" };
  const tool = { commit: "a".repeat(40), ref: "refs/heads/proof" };
  const checks = { workspace: true, nonRoot: true, ports: true, chromium: false, gitUtc: true,
    zsh: true, uv: true, python313: true, node24: true, pnpm: true };
  const remote = (action) => {
    assert.equal(action, "list");
    return { data: [{ id: "standing", job_config: { ccr: { environment_id: pin.environmentId } } }] };
  };
  const check = (options = {}) => checkCloudSetup({ claudeEnvironment: pin.environmentId }, {
    home: f.home, account: { uuid: pin.accountUuid }, environmentPin: pin, remote, ...options });
  const record = (flags, at = Date.now()) => confirmCloudEnvironment({ home: f.home, pin, environmentId: pin.environmentId,
    tool, sessionId: "session-fixture", completed: true, now: at, outcome: { name: "cloud-capabilities", exitCode: 0,
      stdoutTail: "CLOUD_HOST_RUNTIME " + JSON.stringify({ commit: tool.commit, checks: flags }) } });
  const refused = (result) => {
    assert.equal(result.ok, false);
    const detail = result.checks.find((row) => row.check === "lane-tools")?.detail;
    for (const pattern of [/claude.ai\/code/, /Setup script/, /cloud-env-setup.sh/, /CLOUD_CLAUDE_ENV/, /config.env/]) assert.match(detail, pattern);
  };
  refused(check({ remote: () => ({ data: [] }) }));
  refused(check());
  record(checks);
  assert.equal(check().ok, false, "a previous browser revision cannot satisfy the canonical setup");
  record({...checks, chromium:true, chromium1254:true});
  assert.equal(check().ok, true);
  refused(check({ account: { uuid: "b0b02222-2222-4222-b222-222222222222" } }));
  refused(check({ environmentPin: null }));
  for (const name of ["zsh", "uv", "python313", "node24", "pnpm"]) {
    record({ ...checks, chromium:true, chromium1254:true, [name]: false });
    refused(check());
  }
  record(checks, Date.now() - 31 * 60_000);
  refused(check());
});


test("AC-102 completion cannot rebind an unpinned, repinned or old run", (t) => {
  const f = makeHome("vibe-launch-proof-");
  t.after(f.cleanup);
  const pin = { accountUuid: "a0a01111-1111-4111-a111-111111111111", environmentId: "env_Fixture" };
  const checks = { workspace: true, nonRoot: true, ports: true, chromium: true, gitUtc: true, node24: true };
  const commit = "a".repeat(40);
  const outcome = { name: "cloud-capabilities", exitCode: 0, stdoutTail: "CLOUD_HOST_RUNTIME " + JSON.stringify({ commit, checks }) };
  const run = { runId: "run", routineId: "routine", sessionId: "session", startedAt: new Date().toISOString() };
  const measured = () => measuredSetupTools(f.home, pin, pin.accountUuid, pin.environmentId)?.node24;
  const canonical = [{name:outcome.name,command:CLOUD_CAPABILITIES_COMMAND,capabilityProbe:true}];
  const capture = (fields, lanes=canonical) => recordRuntimeFromValidation({ lanes, home: f.home, branch: "main", currentAccount: () => pin.accountUuid,
    ledger: () => ({ environmentPin: pin, runs: [{ ...run, ...fields }] }) }, { commit, lanes: [outcome] },
    { ...run, status: "completed", environment: { id: pin.environmentId } });
  capture({});
  assert.equal(measured(), undefined);
  capture({ accountUuid: "other", environmentId: pin.environmentId });
  assert.equal(measured(), undefined);
  capture({ ...pin, startedAt: new Date(Date.now() - 31 * 60_000).toISOString() });
  assert.equal(measured(), undefined);
  capture(pin,[{name:outcome.name,command:"workflow step",workflow:{}}]);
  assert.equal(measured(),undefined);
  capture(pin);
  assert.equal(measured(), true);
});

test("AC-102 measures selected executables and exact required language versions; zsh counts only with both its packages configured", async () => {
  const { measureLaneTools } = await import("./cloud-capability-probe.mjs");
  const stdout = ["install ok installed\ninstall ok installed", "uv 0.10.2", "Python 3.13.3", "v24.1.2", "10.1.2"];
  const observe = (outputs) => {
    let index = 0;
    return measureLaneTools(async (name, args) => {
      assert.deepEqual([name, ...args], [
        ["dpkg-query", "-W", "-f=${Status}\\n", "zsh", "zsh-common"], ["uv", "--version"], ["uv", "run", "--offline", "--no-project", "--python", "3.13", "python", "--version"],
        ["node", "--version"], ["pnpm", "--version"],
      ][index]);
      const output = outputs[index++];
      return { result: output ? "YES" : "NO", output };
    });
  };
  assert.deepEqual(await observe(stdout), { zsh: true, uv: true, python313: true, node24: true, pnpm: true });
  assert.deepEqual(await observe(["", "", "Python 3.12.0", "v22.0.0", ""]), { zsh: false, uv: false, python313: false, node24: false, pnpm: false });
  // ISS-14476 r24: a cached environment held zsh and zsh-common unpacked, not configured; zsh --version still ran.
  for (const state of ["install ok installed\ninstall ok unpacked", "install ok unpacked\ninstall ok unpacked", "install ok installed"]) {
    assert.equal((await observe([state, ...stdout.slice(1)])).zsh, false, state);
  }
  // ISS-14476 cse_0197q288: the cloud sets UV_NATIVE_TLS, so uv prints its deprecation warning on the merged capture
  // ahead of the interpreter's version; the warning is not the version line, and a warning alone is no version.
  const warning = "warning: The `UV_NATIVE_TLS` environment variable is deprecated and will be removed in a future release. Use `UV_SYSTEM_CERTS` instead.";
  assert.equal((await observe([stdout[0], stdout[1], `${warning}\nPython 3.13.14`, ...stdout.slice(3)])).python313, true);
  assert.equal((await observe([stdout[0], stdout[1], `${warning}\nPython 3.12.0`, ...stdout.slice(3)])).python313, false);
  assert.equal((await observe([stdout[0], stdout[1], warning, ...stdout.slice(3)])).python313, false);
});

test("ISS-14476 setup finishes interrupted dpkg configuration with no prompt, installs zsh unless both packages are configured, and fails loudly", (t) => {
  const f = makeHome("vibe-zsh-setup-");
  t.after(f.cleanup);
  const template = readFileSync(new URL("../../../skills/fleet-orchestrator/templates/cloud-env-setup.sh", import.meta.url), "utf8").split("\n");
  const start = template.findIndex((line) => line.startsWith("  # zsh (CI's node-tests lane)"));
  const end = template.findIndex((line) => line.startsWith("  # uv + Python 3.13"));
  assert.ok(start > 0 && end > start, "the template's zsh block is found");
  const bin = path.join(f.root, "bin"), state = path.join(f.root, "state"), log = path.join(f.root, "log");
  mkdirSync(bin);
  // dpkg and apt-get record any input they could read: a conffile prompt reads its answer from there.
  const fake = (name, body, prompts = true) => writeFileSync(path.join(bin, name),
    `#!/bin/bash\n${prompts ? `if read -r line; then echo "${name} read input" >> "$LOG"; fi\n` : ""}${body}\n`, { mode: 0o755 });
  fake("dpkg", 'echo "dpkg $* frontend=$DEBIAN_FRONTEND" >> "$LOG"\n[ -n "$CONFIGURE_FAILS" ] && exit 1\n[ -n "$CONFIGURE_LEAVES" ] && exit 0\nsed -i.bak s/unpacked/installed/ "$STATE"; exit 0');
  fake("dpkg-query", 'case "$*" in *binary:Package*) awk \'NR == 1 { print $0 " zsh" } NR == 2 { print $0 " zsh-common" }\' "$STATE"; exit 0;; -W) exit 0;; esac\n[ -s "$STATE" ] || exit 1\ncat "$STATE"', false);
  fake("apt-get", 'echo "apt-get $* frontend=$DEBIAN_FRONTEND" >> "$LOG"\ncase " $* " in *" install "*) [ -n "$APT_FAILS" ] && exit 100; printf \'install ok %s\\ninstall ok %s\\n\' "${LEAVES:-installed}" "${LEAVES:-installed}" > "$STATE";; esac');
  const setup = (before, env = {}) => {
    writeFileSync(state, before);
    writeFileSync(log, "");
    const child = spawnSync("bash", ["-c", 'SUDO=""\n' + template.slice(start, end).join("\n") + "\necho done"], { encoding: "utf8", input: "y\ny\n",
      env: { PATH: `${bin}:/usr/bin:/bin`, STATE: state, LOG: log, ...env } });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, log: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  };
  const configure = "dpkg --force-confdef --force-confold --configure -a frontend=noninteractive";
  const install = "apt-get install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold zsh frontend=noninteractive";
  const unpacked = "install ok unpacked\ninstall ok unpacked\n", installed = "install ok installed\ninstall ok installed\n";
  assert.deepEqual(setup(unpacked), { status: 0, stdout: "done\n", stderr: "", log: [configure] }, "r24's unpacked packages are configured in place");
  assert.deepEqual(setup(installed), { status: 0, stdout: "done\n", stderr: "", log: [configure] });
  assert.deepEqual(setup(""), { status: 0, stdout: "done\n", stderr: "", log: [configure, "apt-get update frontend=", install] }, "absent packages are installed");
  assert.deepEqual(setup("install ok installed\n"), { status: 0, stdout: "done\n", stderr: "", log: [configure, "apt-get update frontend=", install] },
    "zsh without zsh-common is installed again");
  assert.deepEqual(setup(unpacked, { CONFIGURE_FAILS: "1" }), { status: 1, stdout: "", stderr: "dpkg --configure -a failed\n", log: [configure] });
  assert.deepEqual(setup("", { APT_FAILS: "1" }), { status: 1, stdout: "", stderr: "zsh install failed\n", log: [configure, "apt-get update frontend=", install] });
  assert.deepEqual(setup("", { LEAVES: "unpacked" }), { status: 1, stdout: "", stderr: "zsh is not configured: install ok unpacked install ok unpacked \n",
    log: [configure, "apt-get update frontend=", install] }, "an install that leaves zsh unconfigured fails the setup");
  assert.deepEqual(setup(unpacked, { CONFIGURE_LEAVES: "1" }), { status: 1, stdout: "", stderr: "dpkg left packages partly installed: zsh:unpacked zsh-common:unpacked \n",
    log: [configure] }, "a configure that leaves any package partly installed fails the setup before any install");
});

test("ISS-14476 the template runs the validation host's package repair verbatim, before it installs zsh", () => {
  const template = readFileSync(new URL("../../../skills/fleet-orchestrator/templates/cloud-env-setup.sh", import.meta.url), "utf8");
  const at = template.indexOf(PACKAGE_REPAIR);
  assert.ok(at > 0, "the template holds the exact lines cloud validation runs before any lane");
  assert.ok(at < template.indexOf("apt-get install"), "the repair comes before the zsh install");
});

test("ISS-14476 the host package repair finishes unpacked packages with no prompt, names them, fails on a package left partly installed, and runs only as root with dpkg", (t) => {
  const f = makeHome("vibe-package-repair-");
  t.after(f.cleanup);
  const bin = path.join(f.root, "bin"), state = path.join(f.root, "state"), log = path.join(f.root, "log"), mode = path.join(f.root, "mode");
  const database = path.join(f.root, "status");
  mkdirSync(bin);
  writeFileSync(database, "");
  // The repair passes only PATH, so each fake reads its fixture from a fixed path and records any input it could read.
  const fake = (name, body) => writeFileSync(path.join(bin, name), `#!/bin/bash\nif read -r line; then echo "${name} read input" >> "${log}"; fi\n${body}\n`, { mode: 0o755 });
  fake("dpkg", `echo "dpkg $* frontend=$DEBIAN_FRONTEND" >> "${log}"\ncase "$(cat "${mode}")" in fails) exit 1;; leaves) exit 0;; esac\nsed -i.bak 's/ unpacked / installed /' "${state}"`);
  fake("dpkg-query", `case "$*" in *binary:Package*) cat "${state}";; esac`);
  const environment = { PATH: `${bin}:/usr/bin:/bin` };
  const repair = (before, how = "") => {
    writeFileSync(state, before);
    writeFileSync(mode, how);
    writeFileSync(log, "");
    return { ...repairHostPackages({ uid: 0, database, environment }), log: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  };
  const stale = "install ok unpacked zsh\ninstall ok unpacked zsh-common\ninstall ok installed bash\ndeinstall ok config-files old\nunknown ok not-installed gone\n";
  const configure = "dpkg --force-confdef --force-confold --configure -a frontend=noninteractive";
  assert.deepEqual(repair(stale), { exitCode: 0, partlyInstalled: ["zsh:unpacked", "zsh-common:unpacked"], detail: "", log: [configure] },
    "r24's unpacked packages are finished and named");
  assert.deepEqual(repair(stale.replaceAll(" unpacked ", " installed ")), { exitCode: 0, partlyInstalled: [], detail: "", log: [configure] });
  assert.deepEqual(repair("install reinstreq half-installed zsh\n", "leaves"), { exitCode: 1, partlyInstalled: ["zsh:half-installed"],
    detail: "exit 1; dpkg left packages partly installed: zsh:half-installed", log: [configure] }, "a package configure cannot finish fails the repair");
  assert.deepEqual(repair(stale, "fails"), { exitCode: 1, partlyInstalled: ["zsh:unpacked", "zsh-common:unpacked"],
    detail: "exit 1; dpkg --configure -a failed", log: [configure] });
  writeFileSync(log, "");
  assert.equal(repairHostPackages({ uid: 1000, database, environment }), null, "only root repairs");
  assert.equal(repairHostPackages({ uid: 0, database: path.join(f.root, "absent"), environment }), null, "a host with no dpkg database has nothing to repair");
  assert.equal(readFileSync(log, "utf8"), "", "neither runs dpkg");
});
