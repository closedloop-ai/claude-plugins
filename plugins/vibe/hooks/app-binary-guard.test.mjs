import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appBinaryGuard, appBinaryProblem } from "./app-binary-guard.mjs";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { activatedChat } from "./activation-test-support.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-use.mjs");
const APP = "/Applications/Closedloop.app";

test("ISS-14116 item 43: running an app bundle's executable is refused, by path, through env or exec, in a shell payload or a variable", () => {
  const refused = [
    `${APP}/Contents/MacOS/Closedloop --version`,
    `"${APP}/Contents/MacOS/Closedloop" --version`,
    `env ${APP}/Contents/MacOS/Closedloop`,
    `exec ${APP}/Contents/MacOS/Closedloop`,
    `bash -c "${APP}/Contents/MacOS/Closedloop --version"`,
    `BIN=${APP}/Contents/MacOS/Closedloop; $BIN --version`,
    `export BIN="${APP}/Contents/MacOS/Closedloop" && "\${BIN}" --version`,
    `ELECTRON_RUN_AS_NODE=0 ${APP}/Contents/MacOS/Closedloop --version`,
    `cd ${APP}/Contents/MacOS && ./Closedloop --version`,
    `timeout 5 ${APP}/Contents/MacOS/Closedloop --version`,
    `gtimeout -k 2 --foreground 5 ${APP}/Contents/MacOS/Closedloop --version`,
    `nice -n 5 ${APP}/Contents/MacOS/Closedloop --version`,
    `arch -arm64 ${APP}/Contents/MacOS/Closedloop --version`,
    `caffeinate -i ${APP}/Contents/MacOS/Closedloop --version`,
    `stdbuf -o0 ${APP}/Contents/MacOS/Closedloop --version`,
    `taskpolicy -c utility ${APP}/Contents/MacOS/Closedloop --version`,
    `nice -n 5 timeout 5 ${APP}/Contents/MacOS/Closedloop --version`,
    `cd ${APP}/Contents && ../Contents/MacOS/Closedloop --version`,
    `cd ${APP}/Contents && MacOS/Closedloop --version`,
    `ELECTRON_RUN_AS_NODE=1; ${APP}/Contents/MacOS/Closedloop --version`,
    `ELECTRON_RUN_AS_NODE=1 && ${APP}/Contents/MacOS/Closedloop --version`,
  ];
  for (const command of refused) {
    const problem = appBinaryProblem(command) ?? "";
    assert.match(problem, /defaults read "\/Applications\/Closedloop\.app\/Contents\/Info\.plist" CFBundleShortVersionString/, command);
    assert.match(problem, /open -a "\/Applications\/Closedloop\.app"/, command);
  }
});

test("ISS-14116 item 43: a Node helper run with ELECTRON_RUN_AS_NODE=1, the Info.plist read and open -a are allowed", () => {
  const allowed = [
    `ELECTRON_RUN_AS_NODE=1 "${APP}/Contents/MacOS/Closedloop" "${APP}/Contents/Resources/mesh-helper.js" list`,
    `env ELECTRON_RUN_AS_NODE=1 ${APP}/Contents/MacOS/Closedloop helper.js`,
    `export ELECTRON_RUN_AS_NODE=1; ${APP}/Contents/MacOS/Closedloop helper.js`,
    `ELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE; ${APP}/Contents/MacOS/Closedloop helper.js`,
    `defaults read "${APP}/Contents/Info.plist" CFBundleShortVersionString`,
    "open -a Closedloop",
    `open -a "${APP}"`,
    `ls ${APP}/Contents/MacOS/`,
    `codesign -dv ${APP}/Contents/MacOS/Closedloop`,
    `cd ${APP}/Contents/MacOS && ls`,
    `timeout 10 env ELECTRON_RUN_AS_NODE=1 ${APP}/Contents/MacOS/Closedloop helper.js`,
    `nice -n 5 ls ${APP}/Contents/MacOS`,
  ];
  for (const command of allowed) assert.equal(appBinaryProblem(command), null, command);
});

test("ISS-14116 item 43: the hook's own prefilter passes a bundle path written without a slash after .app to the check", () => {
  for (const command of [`cd ${APP} && ./Contents/MacOS/Closedloop --version`, `cd "${APP}" && Contents/MacOS/Closedloop --version`]) {
    assert.equal(appBinaryGuard({ tool_input: { command } })?.decision, "deny", command);
  }
});

test("ISS-14116 item 43: the PreToolUse hook denies the command that ended every session on 2026-11-18, and the guard is routed", (t) => {
  const chat = activatedChat(t);
  const run = (command) => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ ...chat.payload({ tool_name: "Bash", tool_input: { command } }), cwd: chat.home }), encoding: "utf8", env: chat.env,
  });
  const refused = run(`${APP}/Contents/MacOS/Closedloop --version`);
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run(`defaults read "${APP}/Contents/Info.plist" CFBundleShortVersionString`).stdout, "");
  assert.ok(PRE_TOOL_USE_ROUTES.Bash.some((guard) => guard.run === appBinaryGuard && guard.activated), "routed for activated chats");
});
