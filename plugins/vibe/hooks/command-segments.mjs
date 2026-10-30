// Splits a Bash command line into its simple commands for the PreToolUse
// guards: each segment's leading NAME=value assignments and its words, with
// wrappers (sudo, env, exec and the like) removed so words[0] is the program.

import path from "node:path";

const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)(.*)$/;
const WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "builtin", "env"]);
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const SSH_VALUED = new Set(['-p', '-i', '-o', '-J', '-F', '-l', '-S', '-W', '-L', '-R', '-D', '-b']);
const envSplit = value => {
  const quote = value[0];
  return shellWords((quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value);
};

/** Peel executable wrappers and assignments at any shell boundary; return the first actual program and its environment. */
export function commandPrefix(words, start = 0) {
  const env = {};
  let index = start;
  while (index < words.length) {
    const assignment = ENV_ASSIGN.exec(words[index]);
    if (assignment) { env[assignment[1]] = assignment[3]; index += 1; continue; }
    const wrapper = path.basename(words[index]);
    if (!WRAPPERS.has(wrapper)) break;
    // command -v/-V only inspect names; they never execute the argument.
    if (wrapper === 'command' && ['-v', '-V'].includes(words[index + 1])) break;
    index += 1;
    const boolean = wrapper === 'env' ? ['-i', '--ignore-environment']
      : wrapper === 'exec' ? ['-c', '-l'] : wrapper === 'command' ? ['-p'] : wrapper === 'time' ? ['-p']
        : wrapper === 'sudo' ? ['-n', '-E', '-H', '-S'] : [];
    const valued = wrapper === 'env' ? ['-u', '--unset', '-C', '--chdir']
      : wrapper === 'exec' ? ['-a'] : wrapper === 'sudo'
        ? ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-D', '--chdir', '-C', '--close-from', '-r', '--role', '-t', '--type', '-U', '--other-user'] : [];
    for (;;) {
      if (words[index] === '--') { index += 1; break; }
      const word = words[index] ?? '';
      if (wrapper === 'env' && ['-S', '--split-string'].includes(word)) {
        const split = envSplit(words[index + 1] ?? '');
        words.splice(index, 2, ...split);
        break;
      } else if (wrapper === 'env' && word.startsWith('--split-string=')) {
        const split = envSplit(word.slice('--split-string='.length));
        words.splice(index, 1, ...split);
        break;
      } else if (boolean.includes(word)) index += 1;
      else if (valued.includes(word)) index += 2;
      else if (valued.some(option => option.startsWith('--') ? word.startsWith(`${option}=`) : word.startsWith(option) && word.length > option.length)) index += 1;
      else if (wrapper === 'sudo' && word.startsWith('--')) index += 1;
      else break;
    }
  }
  return { env, index };
}

/** Shell words with quoted whitespace preserved; operators are handled by commandSegments. */
function shellWords(value) {
  const words = [];
  let word = '';
  let quote = null;
  const finish = () => { if (word) words.push(word); word = ''; };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < value.length) word += value[++index];
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) finish();
    else if (char === '\\' && index + 1 < value.length) word += value[++index];
    else word += char;
  }
  finish();
  return words;
}

function commandWords(segment) {
  return shellWords(segment).filter(word => word && !/[<>]/.test(word));
}

function splitCommandText(command) {
  const segments = [];
  const embedded = [];
  let text = '';
  let quote = null;
  const finish = () => { if (text.trim()) segments.push(text.trim()); text = ''; };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      const pair = command.slice(index, index + 2);
      if (quote === '"' && pair === '$(') {
        const substitution = commandSubstitution(command, index + 2, ')');
        if (substitution.text.trim()) embedded.push(substitution.text.trim());
        index = substitution.end;
        continue;
      }
      if (quote === '"' && char === '`') {
        const substitution = commandSubstitution(command, index + 1, '`');
        if (substitution.text.trim()) embedded.push(substitution.text.trim());
        index = substitution.end;
        continue;
      }
      text += char;
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < command.length) text += command[++index];
      continue;
    }
    if (char === '"' || char === "'") { quote = char; text += char; continue; }
    if (char === '\\' && index + 1 < command.length) { text += char + command[++index]; continue; }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||' || pair === '$(') { finish(); index += 1; continue; }
    if (';|&\n()`'.includes(char)) { finish(); continue; }
    text += char;
  }
  finish();
  return [...segments, ...embedded];
}

function commandSubstitution(command, start, terminator) {
  let text = '';
  let quote = null;
  let depth = terminator === ')' ? 1 : 0;
  for (let index = start; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      text += char;
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < command.length) text += command[++index];
      continue;
    }
    if (char === '"' || char === "'") { quote = char; text += char; continue; }
    if (char === '\\' && index + 1 < command.length) { text += char + command[++index]; continue; }
    if (terminator === '`' && char === '`') return { text, end: index };
    if (terminator === ')' && char === '(') { depth += 1; text += char; continue; }
    if (terminator === ')' && char === ')' && --depth === 0) return { text, end: index };
    text += char;
  }
  return { text, end: command.length - 1 };
}

function expandSegment(segment, depth, expandShellPayloads) {
  const words = commandWords(segment);
  const prefix = commandPrefix(words);
  const current = words.slice(prefix.index);
  if (current.length === 0 || depth > 8) return current.length ? [{ env: prefix.env, words: current }] : [];
  if (!expandShellPayloads) return [{ env: prefix.env, words: current }];
  const program = path.basename(current[0]);
  if (program === 'ssh') {
    let index = 1;
    while (current[index]?.startsWith('-')) {
      const option = current[index++];
      if (SSH_VALUED.has(option)) index += 1;
    }
    index += 1;
    const payload = current.slice(index).join(' ');
    return payload ? expandCommand(payload, depth + 1, true) : [{ env: prefix.env, words: current }];
  }
  if (SHELLS.has(program)) {
    let index = 1;
    let executes = false;
    while (/^[-+]/.test(current[index] ?? '')) {
      const option = current[index++];
      if (/c/.test(option.replace(/^[-+]+/, ''))) executes = true;
      if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(option)) index += 1;
    }
    if (executes && index < current.length) return expandCommand(current.slice(index).join(' '), depth + 1, true);
  }
  return [{ env: prefix.env, words: current }];
}

function expandCommand(command, depth = 0, expandShellPayloads = false) {
  return splitCommandText(command).flatMap(segment => expandSegment(segment, depth, expandShellPayloads));
}

/** `{ env, words }` for each simple command in `command`. */
export function commandSegments(command, { expandShellPayloads = false } = {}) {
  return expandCommand(command, 0, expandShellPayloads);
}
