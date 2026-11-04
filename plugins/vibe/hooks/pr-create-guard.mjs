// A vibe PR must carry a current private handoff witness for its exact source.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { commandSegments } from "./command-segments.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { inVibeSession } from "./foreground-guard.mjs";
import { handoffGateProblem } from "../skills/handoff/scripts/handoff-gate.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import os from "node:os";

const VIBE_BRANCH = "vibe/";

/** Whether a shell call opens a PR through GitHub CLI. */
export function createsPullRequest(command) {
  return prCreateCalls(command, process.cwd()).length > 0;
}

/** Resolve each PR call against its execution scope, so child cwd and variables cannot escape. */
export function prCreateCalls(command, initialCwd) {
  const states = new Map([['root', { cwd: initialCwd, uncertainCwd: false, unresolvedTarget: null,
    variables: Object.create(null), directoryStack: [], conditions: [], loopDepth: 0 }]]);
  const stateFor = (scope) => {
    if (states.has(scope)) return states.get(scope);
    const parent = stateFor(scope.slice(0, scope.lastIndexOf('/')));
    const state = { ...parent, variables: Object.assign(Object.create(null), parent.variables),
      directoryStack: [...parent.directoryStack], conditions: [...parent.conditions] };
    states.set(scope, state);
    return state;
  };
  const calls = [];
  const segments = commandSegments(command, { expandShellPayloads: true });
  let payloadCount = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const { env, words, controls, remote, scope, evalPayload, wrapperPayload, substitutions,
      hasSubstitution, unresolvedExecutable } = segments[index];
    const state = stateFor(scope);
    if (unresolvedExecutable) {
      calls.push({ cwd: state.cwd, remote, uncertainCwd: state.uncertainCwd,
        unresolvedTarget: state.unresolvedTarget, unresolvedExecutable });
      continue;
    }
    for (const control of controls ?? []) {
      if (control === 'if') {
        const condition = words[0] === 'true' ? true : words[0] === 'false' ? false : null;
        state.conditions.push(condition);
        if (condition !== null) words.shift();
      } else if (control === 'else' && state.conditions.length) {
        const previous = state.conditions.pop();
        state.conditions.push(previous === null ? null : !previous);
      } else if (control === 'elif' && state.conditions.length) {
        state.conditions[state.conditions.length - 1] = null;
      } else if (control === 'fi') state.conditions.pop();
      else if (['while', 'until', 'for', 'case'].includes(control)) state.loopDepth += 1;
      else if (['done', 'esac'].includes(control)) state.loopDepth = Math.max(0, state.loopDepth - 1);
    }
    if (state.conditions.includes(false)) continue;
    if (words.length === 0) {
      for (const [name, value] of Object.entries(env)) {
        state.variables[name] = hasSubstitution ? literalSubstitutionOutput(substitutions) : value;
      }
      continue;
    }
    if (evalPayload !== undefined || wrapperPayload !== undefined) {
      const payload = evalPayload ?? wrapperPayload;
      const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(payload);
      const name = variable?.[1] ?? variable?.[2];
      const value = name ? variableValue(name, state.variables)
        : !payload ? literalSubstitutionOutput(substitutions) : null;
      if (typeof value !== 'string' || ++payloadCount > 8) continue;
      const nested = commandSegments(value, { expandShellPayloads: true });
      const wrapperScope = wrapperPayload !== undefined ? `${scope}/wrapper${payloadCount}` : scope;
      const prefix = `${wrapperScope}/payload${payloadCount}`;
      segments.splice(index + 1, 0, ...nested.map((entry) => ({ ...entry,
        scope: entry.scope === 'root' ? wrapperScope : `${prefix}${entry.scope.slice(4)}`,
        remote: remote || entry.remote })));
      continue;
    }
    if (words[0] === "export" && words.length > 1) {
      for (const word of words.slice(1)) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
        if (assignment) state.variables[assignment[1]] = hasSubstitution
          ? literalSubstitutionOutput(substitutions) : assignment[2];
      }
      continue;
    }
    if (words[0] === "cd" || words[0] === "pushd") {
      if (state.conditions.includes(null) || state.loopDepth > 0) {
        state.uncertainCwd = true;
        state.unresolvedTarget = 'conditional or loop cwd';
        continue;
      }
      const destination = words.length === 2 ? resolveDirectory(words[1], state.variables) : null;
      if (!destination) { state.uncertainCwd = true; state.unresolvedTarget = words[1] ?? words[0]; }
      else {
        if (words[0] === "pushd") state.directoryStack.push(state.cwd);
        if (path.isAbsolute(destination)) {
          state.cwd = path.resolve(destination);
          state.uncertainCwd = false;
          state.unresolvedTarget = null;
        } else if (!state.uncertainCwd) state.cwd = path.resolve(state.cwd, destination);
      }
      continue;
    }
    if (words[0] === "popd") {
      if (words.length !== 1 || state.directoryStack.length === 0) state.uncertainCwd = true;
      else { state.cwd = state.directoryStack.pop(); state.uncertainCwd = false; state.unresolvedTarget = null; }
      continue;
    }
    const executable = variableValueFromWord(words[0], state.variables) ?? words[0];
    const actionAt = ghCreateAt([executable, ...words.slice(1)]);
    if (actionAt < 0) continue;
    let base = null;
    let bodyFile = null;
    for (let i = actionAt + 2; i < words.length; i += 1) {
      const word = words[i];
      if (["--base", "-B", "--body-file", "-F"].includes(word)) {
        const value = words[++i];
        if (word === "--base" || word === "-B") base = value;
        else bodyFile = value;
      } else if (word.startsWith("--base=")) base = word.slice(7);
      else if (word.startsWith("--body-file=")) bodyFile = word.slice(12);
    }
    calls.push({ cwd: state.cwd, base, bodyFile: bodyFile ? path.resolve(state.cwd, bodyFile) : null,
      remote, uncertainCwd: state.uncertainCwd, unresolvedTarget: state.unresolvedTarget });
  }
  return calls;
}

/** Skip supported GitHub CLI global repo options before matching `pr create`. */
function ghCreateAt(words) {
  if (path.basename(words[0] ?? '') !== 'gh') return -1;
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word === '-R' || word === '--repo') index += 2;
    else if (word.startsWith('--repo=') || /^-R.+/.test(word)) index += 1;
    else break;
  }
  return words[index] === 'pr' && words[index + 1] === 'create' ? index : -1;
}

function variableValue(name, variables) {
  return Object.hasOwn(variables, name) ? variables[name] : process.env[name];
}

function variableValueFromWord(word, variables) {
  const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(word ?? '');
  return variable ? variableValue(variable[1] ?? variable[2], variables) : null;
}

/** Resolve only literal, single-command substitution output without executing it. */
function literalSubstitutionOutput(substitutions) {
  if (substitutions?.length !== 1) return null;
  const entries = commandSegments(substitutions[0], { expandShellPayloads: true });
  if (entries.length !== 1 || entries[0].remote || entries[0].hasSubstitution) return null;
  const words = entries[0].words;
  if (words.slice(1).some((word) => /[$`]/.test(word))) return null;
  if (words[0] === 'printf') return literalPrintfOutput(words.slice(1));
  if (words[0] === 'echo') {
    let index = 1;
    let escapes = false;
    while (/^-[nEe]+$/.test(words[index] ?? '')) {
      for (const option of words[index].slice(1)) {
        if (option === 'e') escapes = true;
        if (option === 'E') escapes = false;
      }
      index += 1;
    }
    const output = words.slice(index).join(' ');
    return escapes ? simpleEscapes(output) : output;
  }
  return null;
}

/** Analyze supported literal output and retain a safe marker after the first unknown directive. */
function literalPrintfOutput(words) {
  if (words.length === 0) return null;
  const format = words[0];
  let output = '';
  let argument = 1;
  do {
    const before = argument;
    for (let index = 0; index < format.length; index += 1) {
      const char = format[index];
      if (char === '%') {
        const token = literalFormatToken(format, index, words, argument);
        if (!token) return `${output}VIBE_UNKNOWN_PRINTF_VALUE`;
        output += token.text;
        argument = token.argument;
        index = token.end;
        if (token.stop) return output;
      } else if (char === '\\') {
        const escaped = decodeLiteralEscape(format, index);
        if (!escaped) return null;
        output += escaped.text;
        index = escaped.end;
        if (escaped.stop) return output;
      } else output += char;
    }
    if (argument === before) return output;
  } while (argument < words.length);
  return argument === words.length ? output : null;
}

/** Decode only string-like printf directives with literal flags, width and precision. */
function literalFormatToken(format, start, words, nextArgument) {
  let index = start + 1;
  if (format[index] === '%') return { text: '%', end: index, argument: nextArgument };
  let flags = '';
  while (index < format.length && '-+ 0#'.includes(format[index])) flags += format[index++];
  let width = 0;
  if (format[index] === '*') {
    const value = literalNumber(words[nextArgument++]);
    if (value === null) return null;
    width = Math.abs(value);
    if (value < 0) flags += '-';
    index += 1;
  } else {
    const digits = /^\d+/.exec(format.slice(index))?.[0];
    if (digits) { width = Number(digits); index += digits.length; }
  }
  let precision = null;
  if (format[index] === '.') {
    index += 1;
    if (format[index] === '*') {
      const value = literalNumber(words[nextArgument++]);
      if (value === null) return null;
      precision = value < 0 ? null : value;
      index += 1;
    } else {
      const digits = /^\d+/.exec(format.slice(index))?.[0] ?? '';
      precision = digits ? Number(digits) : 0;
      index += digits.length;
    }
  }
  if (!Number.isSafeInteger(width) || (precision !== null && !Number.isSafeInteger(precision))) return null;
  const directive = format[index];
  if (!['s', 'b', 'c'].includes(directive)) return null;
  let value = nextArgument < words.length ? words[nextArgument++] : '';
  if (directive === 'b') {
    const decoded = decodedEscapes(value);
    if (decoded === null) return null;
    value = decoded.text;
    if (decoded.stop) return { text: value, end: index, argument: nextArgument, stop: true };
  }
  if (directive === 'c') value = Array.from(value)[0] ?? '';
  else if (precision !== null) value = Array.from(value).slice(0, precision).join('');
  const paddingLength = Math.max(0, width - Array.from(value).length);
  const padding = paddingLength > 0
    ? (flags.includes('0') && !flags.includes('-') ? '0' : ' ').repeat(Math.min(paddingLength, 65536)) : '';
  return { text: flags.includes('-') ? value + padding : padding + value, end: index, argument: nextArgument };
}

function literalNumber(value) {
  return typeof value === 'string' && /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value) : null;
}

function simpleEscapes(value) {
  return decodedEscapes(value)?.text ?? null;
}

function decodedEscapes(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') { output += value[index]; continue; }
    const escaped = decodeLiteralEscape(value, index);
    if (!escaped) return null;
    output += escaped.text;
    index = escaped.end;
    if (escaped.stop) return { text: output, stop: true };
  }
  return { text: output, stop: false };
}

function decodeLiteralEscape(value, index) {
  const marker = value[index + 1];
  if (marker === 'c') return { text: '', end: index + 1, stop: true };
  const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\' };
  if (Object.hasOwn(simple, marker)) return { text: simple[marker], end: index + 1 };
  if (marker === 'x') {
    const digits = /^[0-9a-fA-F]{1,2}/.exec(value.slice(index + 2))?.[0];
    return digits ? { text: String.fromCodePoint(Number.parseInt(digits, 16)), end: index + 1 + digits.length }
      : null;
  }
  if (marker === '0') {
    const digits = /^[0-7]{1,3}/.exec(value.slice(index + 2))?.[0];
    return digits ? { text: String.fromCodePoint(Number.parseInt(digits, 8)), end: index + 1 + digits.length }
      : { text: '\0', end: index + 1 };
  }
  if (marker === 'u' || marker === 'U') {
    const width = marker === 'u' ? 4 : 8;
    const digits = value.slice(index + 2, index + 2 + width);
    const point = Number.parseInt(digits, 16);
    return digits.length === width && /^[0-9a-fA-F]+$/.test(digits) && point <= 0x10ffff
      && !(point >= 0xd800 && point <= 0xdfff)
      ? { text: String.fromCodePoint(point), end: index + 1 + width } : null;
  }
  return null;
}

function resolveDirectory(raw, variables) {
  const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(raw ?? "");
  const value = variable ? variables[variable[1] ?? variable[2]] ?? process.env[variable[1] ?? variable[2]] : raw;
  return typeof value === "string" && value && !/[$`*?]/.test(value) && !value.startsWith("~") ? value : null;
}

/**
 * Whether a session-less PR from `cwd` is vibe work, judged by that worktree alone: null outside a
 * git repository, true on a vibe/ branch, else false. Other worktrees' session records never
 * decide, because an abandoned session keeps an `active` record indefinitely (PR #371 review: a
 * repository with any such record refused every scoped conversation's PRs in all its worktrees).
 */
export function vibeWorktree(cwd) {
  try { git(cwd, ["rev-parse", "--git-dir"]); }
  catch { return null; }
  try { return git(cwd, ["branch", "--show-current"]).startsWith(VIBE_BRANCH); }
  catch { return false; }
}

/** Refuse PR publication in a vibe session without the final handoff witness. */
export function prCreateGuard(event, home = os.homedir()) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return null;
  const calls = prCreateCalls(command, eventCwd(event));
  if (calls.length === 0) return null;
  const startingCwd = eventCwd(event);
  const recorded = inVibeSession(startingCwd) || vibeWorktree(startingCwd) === true ||
    calls.some(call => !call.remote && !call.uncertainCwd &&
      (inVibeSession(call.cwd) || vibeWorktree(call.cwd) === true));
  if (!conversationSkill(event, home) && !recorded) return null;
  for (const call of calls) {
    if (call.unresolvedExecutable) {
      if (call.remote || call.uncertainCwd || inVibeSession(call.cwd) || vibeWorktree(call.cwd) === true) {
        return deny(`gh pr create refused: ${call.unresolvedExecutable} in ${call.cwd}`);
      }
      continue;
    }
    if (call.remote) return deny("gh pr create refused: remote or unresolved shell cwd cannot prove a local vibe handoff gate");
    if (call.uncertainCwd) return deny(`gh pr create refused: unresolved shell cwd ${call.unresolvedTarget ?? "unknown"} from ${call.cwd} cannot prove a local vibe handoff gate`);
    if (!inVibeSession(call.cwd)) {
      if (vibeWorktree(call.cwd) === false) continue;
      return deny("gh pr create refused: no vibe session record in the command worktree");
    }
    const problem = handoffGateProblem(call.cwd, { base: call.base, bodyFile: call.bodyFile });
    if (problem) return deny(`gh pr create refused: ${problem}; run the final handoff gate on the published source`);
  }
  return null;
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
