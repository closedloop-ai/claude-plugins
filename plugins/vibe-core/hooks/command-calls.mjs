// Every simple command a Bash command line runs, in order, with the directory
// and exported variables it runs with. The walk follows cd, pushd and popd,
// env -C and sudo -D prefixes, literal and exported variables, subshell and
// pipeline scopes, and the eval and shell -c payloads commandSegments expands.
// A directory or value it cannot prove is reported as unknown, never guessed.
// Shared by the guards that act on where a command runs (pr-create-guard.mjs,
// merge-guard.mjs).

import path from "node:path";
import { commandSegments } from "./command-segments.mjs";

/** An `exported` value that only running part of the command line could tell. */
export const UNKNOWN_VALUE = Symbol("unknown value");

const VARIABLE_WORD = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Each command `command` runs when started in `initialCwd`. A command is `{ env, words, remote,
 * cwd, uncertainCwd, unresolvedTarget, substituted, exported, value }`: words[0] is resolved through
 * literal variables; `exported` maps each variable the command line exported, assigned over
 * `environment` or unset to a string, null (unset) or UNKNOWN_VALUE; `value(word)` is the literal
 * value of one word or null when it cannot be read. Where expansion stopped the entry is `{ cwd,
 * remote, uncertainCwd, unresolvedTarget, unresolvedExecutable }`. With `expandEnvironment: false`
 * a `$NAME` is read only from the command line itself, never from `environment`.
 */
export function commandCalls(command, initialCwd, { environment = process.env, expandEnvironment = true } = {}) {
  const base = expandEnvironment ? environment : Object.create(null);
  const states = new Map([['root', { cwd: initialCwd, uncertainCwd: false, unresolvedTarget: null,
    variables: Object.create(null), exported: Object.create(null), directoryStack: [], conditions: [], loopDepth: 0 }]]);
  const stateFor = (scope) => {
    if (states.has(scope)) return states.get(scope);
    const parent = stateFor(scope.slice(0, scope.lastIndexOf('/')));
    const state = { ...parent, variables: Object.assign(Object.create(null), parent.variables),
      exported: Object.assign(Object.create(null), parent.exported),
      directoryStack: [...parent.directoryStack], conditions: [...parent.conditions] };
    states.set(scope, state);
    return state;
  };
  const assign = (state, name, value, exporting) => {
    state.variables[name] = value;
    const visible = exporting || (Object.hasOwn(state.exported, name) ? state.exported[name] !== null
      : Object.hasOwn(environment, name));
    if (visible) state.exported[name] = value ?? UNKNOWN_VALUE;
  };
  const calls = [];
  const segments = commandSegments(command, { expandShellPayloads: true });
  let payloadCount = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const { env, words, controls, remote, scope, evalPayload, wrapperPayload, substitutions,
      hasSubstitution, unresolvedExecutable, chdir, chdirPayload } = segments[index];
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
        assign(state, name, hasSubstitution ? literalSubstitutionOutput(substitutions) : value, false);
      }
      continue;
    }
    if (evalPayload !== undefined || wrapperPayload !== undefined) {
      const payload = evalPayload ?? wrapperPayload;
      const variable = VARIABLE_WORD.exec(payload);
      const name = variable?.[1] ?? variable?.[2];
      const value = name ? variableValue(name, state.variables, base)
        : !payload ? literalSubstitutionOutput(substitutions) : null;
      if (typeof value !== 'string' || ++payloadCount > 8) continue;
      const nested = commandSegments(value, { expandShellPayloads: true });
      const wrapperScope = wrapperPayload !== undefined ? `${scope}/wrapper${payloadCount}` : scope;
      const prefix = `${wrapperScope}/payload${payloadCount}`;
      segments.splice(index + 1, 0, ...nested.map((entry) => ({ ...entry,
        scope: entry.scope === 'root' ? wrapperScope : `${prefix}${entry.scope.slice(4)}`,
        remote: remote || entry.remote,
        ...(chdir === undefined ? {} : { chdirPayload: chdir }) })));
      continue;
    }
    if (words[0] === "export" && words.length > 1) {
      for (const word of words.slice(1)) {
        const assignment = ASSIGNMENT.exec(word);
        if (assignment) assign(state, assignment[1], hasSubstitution
          ? literalSubstitutionOutput(substitutions) : assignment[2], true);
        else if (NAME.test(word) && Object.hasOwn(state.variables, word)) assign(state, word, state.variables[word], true);
      }
      continue;
    }
    if (words[0] === "unset") {
      if (!words.includes("-f")) {
        for (const name of words.slice(1).filter((word) => NAME.test(word))) {
          state.variables[name] = null;
          state.exported[name] = null;
        }
      }
      continue;
    }
    if (words[0] === "cd" || words[0] === "pushd") {
      if (state.conditions.includes(null) || state.loopDepth > 0) {
        state.uncertainCwd = true;
        state.unresolvedTarget = 'conditional or loop cwd';
        continue;
      }
      const destination = words.length === 2 ? resolveDirectory(words[1], state.variables, base) : null;
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
    const executable = variableValueFromWord(words[0], state.variables, base) ?? words[0];
    const variables = Object.assign(Object.create(null), state.variables);
    const exported = Object.assign(Object.create(null), state.exported);
    const value = (word) => wordValue(word, variables, base);
    for (const [name, raw] of Object.entries(env)) exported[name] = hasSubstitution ? UNKNOWN_VALUE : value(raw) ?? UNKNOWN_VALUE;
    calls.push({ env, words: [executable, ...words.slice(1)], remote, substituted: substitutions.length > 0,
      exported, value, ...commandCwd(state, chdir, chdirPayload, base) });
  }
  return calls;
}

/** Skip GitHub CLI's global repo options and return the index of `pr <action>`, or -1. */
export function ghPrAt(words, action) {
  if (path.basename(words[0] ?? '') !== 'gh') return -1;
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word === '-R' || word === '--repo') index += 2;
    else if (word.startsWith('--repo=') || /^-R.+/.test(word)) index += 1;
    else break;
  }
  return words[index] === 'pr' && words[index + 1] === action ? index : -1;
}

/** The directory one command runs in: its shell's, moved by an env -C or sudo -D prefix. */
function commandCwd(state, chdir, chdirPayload, base) {
  const shell = { cwd: state.cwd, uncertainCwd: state.uncertainCwd, unresolvedTarget: state.unresolvedTarget };
  if (chdirPayload !== undefined) return { ...shell, uncertainCwd: true, unresolvedTarget: `a shell started in ${chdirPayload}` };
  if (chdir === undefined) return shell;
  const destination = resolveDirectory(chdir, state.variables, base);
  if (!destination) return { ...shell, uncertainCwd: true, unresolvedTarget: chdir };
  if (path.isAbsolute(destination)) return { cwd: path.resolve(destination), uncertainCwd: false, unresolvedTarget: null };
  return shell.uncertainCwd ? shell : { ...shell, cwd: path.resolve(state.cwd, destination) };
}

function variableValue(name, variables, environment) {
  return Object.hasOwn(variables, name) ? variables[name] : environment[name];
}

function variableValueFromWord(word, variables, environment) {
  const variable = VARIABLE_WORD.exec(word ?? '');
  return variable ? variableValue(variable[1] ?? variable[2], variables, environment) : null;
}

/** A word's literal value: itself, or one whole known `$NAME`; null for anything else the shell would expand. */
function wordValue(word, variables, environment) {
  if (typeof word !== 'string') return null;
  if (VARIABLE_WORD.test(word)) {
    const value = variableValueFromWord(word, variables, environment);
    return typeof value === 'string' && !/[$`]/.test(value) ? value : null;
  }
  return /[$`]/.test(word) ? null : word;
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


function resolveDirectory(raw, variables, environment) {
  const variable = VARIABLE_WORD.exec(raw ?? "");
  const value = variable ? variableValue(variable[1] ?? variable[2], variables, environment) : raw;
  return typeof value === "string" && value && !/[$`*?]/.test(value) && !value.startsWith("~") ? value : null;
}
