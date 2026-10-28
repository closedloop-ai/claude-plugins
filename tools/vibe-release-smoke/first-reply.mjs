// Judges a real vibe first turn captured by smoke.mjs (ISS-13315). Pure: no process, file or network.

export const SETUP_HEADING = "Setup check";
export const VERSION_UNKNOWN_LINE = "I couldn't check whether vibe is up to date";
const NOT_RUN = /has not run in this conversation/i;
const STARTUP_SCRIPT = /plugin-version\.mjs['"]?\s+(check|status)\b/;
const RECORD_FAILURE = /recordError|EPERM|EACCES|operation not permitted/;

/** The first agent message that carries the setup check block, with the block's lines, or null. */
export function findSetupBlock(messages) {
  for (const message of messages) {
    const text = String(message.text ?? "");
    const start = text.indexOf(SETUP_HEADING);
    if (start === -1) {
      continue;
    }
    const lines = text.slice(start).split("\n");
    const block = [lines[0]];
    for (const line of lines.slice(1)) {
      if (!line.trim().startsWith("- ")) {
        break;
      }
      block.push(line.trim());
    }
    return { message, lines: block };
  }
  return null;
}

/**
 * Every failure in a captured first turn, empty when it passes. `expected` is
 * {harness: "Codex", versions: {"closedloop-core": "1.5.3", vibe: "1.1.13"}, maxSeconds}.
 * `messages` are agent messages ({t, phase, text}) and `commands` the commands it ran
 * ({command, exitCode, output, approval}).
 */
export function assessFirstReply({ messages, commands, expected }) {
  const failures = [];
  const found = findSetupBlock(messages);
  if (!found) {
    return ["no agent message carried the setup check block"];
  }
  const { lines, message } = found;
  const harnessLine = lines.find((line) => line.startsWith(`- ${expected.harness}:`));
  if (!harnessLine) {
    failures.push(`the setup check has no ${expected.harness} line: ${JSON.stringify(lines)}`);
  } else {
    for (const [name, version] of Object.entries(expected.versions)) {
      if (!harnessLine.includes(`${name} ${version}`)) {
        failures.push(`the ${expected.harness} line does not show the installed ${name} ${version}: ${harnessLine}`);
      } else if (!new RegExp(`${escape(name)} ${escape(version)} \\((latest|\\d+\\.\\d+\\.\\d+ available)\\)`).test(harnessLine)) {
        failures.push(`the ${expected.harness} line does not show a completed latest-version comparison for ${name}: ${harnessLine}`);
      }
    }
  }
  if (lines.some((line) => NOT_RUN.test(line))) {
    failures.push(`the setup check says the version check has not run: ${JSON.stringify(lines)}`);
  }
  for (const other of messages) {
    if (plain(other.text).includes(VERSION_UNKNOWN_LINE)) {
      failures.push(`the person was told the version could not be checked: ${JSON.stringify(other.text)}`);
    }
  }
  const startup = commands.filter((entry) => STARTUP_SCRIPT.test(entry.command ?? ""));
  if (startup.length === 0) {
    failures.push("the startup version check never ran");
  }
  // A first attempt inside the sandbox may fail and be run again escalated; the run the
  // conversation ends on must have finished and saved this conversation's record.
  const last = startup.at(-1);
  if (last && (last.exitCode !== 0 || RECORD_FAILURE.test(last.output ?? ""))) {
    failures.push(`the last startup command could not finish or save its record (exit ${last.exitCode}): ${last.command} -> ${String(last.output ?? "").slice(0, 300)}`);
  }
  if (Number.isFinite(expected.maxSeconds) && Number(message.t) > expected.maxSeconds) {
    failures.push(`the setup check reached the person after ${message.t}s, over the ${expected.maxSeconds}s budget`);
  }
  return failures;
}

/** Text with typographic apostrophes as plain ones, as models write either. */
function plain(text) {
  return String(text ?? "").replaceAll("\u2019", "'");
}

function escape(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
