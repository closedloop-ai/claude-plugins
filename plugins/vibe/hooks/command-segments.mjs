// Splits a Bash command line into its simple commands for the PreToolUse
// guards: each segment's leading NAME=value assignments and its words, with
// wrappers (sudo, env, exec and the like) removed so words[0] is the program.

import path from "node:path";

const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)(.*)$/;
const WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "builtin", "env"]);
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const CONTROL = new Set(['{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until',
  'for', 'case', 'esac']);
const MAX_NESTED_SHELL_DEPTH = 64;
const CHDIR_OPTIONS = Object.freeze({ env: ['-C', '--chdir'], sudo: ['-D', '--chdir'] });
const SSH_VALUED = new Set(['-p', '-i', '-o', '-J', '-F', '-l', '-S', '-W', '-L', '-R', '-D', '-b',
  '-E', '-B', '-I', '-w', '-c', '-e', '-m', '-O', '-P']);
const envSplit = value => {
  const quote = value[0];
  return shellWords((quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value);
};

/**
 * Peel executable wrappers and assignments at any shell boundary; return the first actual program,
 * its environment and, when `env -C` or `sudo -D` moves it, the directory it runs in.
 */
export function commandPrefix(words, start = 0) {
  const env = {};
  let chdir;
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
      else if (valued.includes(word)) {
        if (CHDIR_OPTIONS[wrapper]?.includes(word)) chdir = words[index + 1] ?? '';
        index += 2;
      } else if (valued.some(option => attachedValue(word, option) !== null)) {
        const option = CHDIR_OPTIONS[wrapper]?.find(name => attachedValue(word, name) !== null);
        if (option) chdir = attachedValue(word, option);
        index += 1;
      } else if (wrapper === 'sudo' && word.startsWith('--')) index += 1;
      else break;
    }
  }
  return chdir === undefined ? { env, index } : { env, index, chdir };
}

/** The value `word` attaches to `option` (`--chdir=dir`, `-Cdir`), or null. */
function attachedValue(word, option) {
  if (option.startsWith('--')) return word.startsWith(`${option}=`) ? word.slice(option.length + 1) : null;
  return word.startsWith(option) && word.length > option.length ? word.slice(option.length) : null;
}

/** Shell words with quoted whitespace preserved; operators are handled by commandSegments. */
function shellWords(value) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  const finish = () => { if (started) words.push(word); word = ''; started = false; };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < value.length) word += value[++index];
      else word += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) finish();
    else if (char === '\\' && index + 1 < value.length) { word += value[++index]; started = true; }
    else { word += char; started = true; }
  }
  finish();
  return words;
}

/** Keep executable words while removing attached redirection operators and their targets. */
function commandWords(segment) {
  let text = '';
  let quote = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      text += char;
      if (char === '\\' && quote === '"' && index + 1 < segment.length) text += segment[++index];
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; text += char; continue; }
    if (char === '\\' && index + 1 < segment.length) { text += char + segment[++index]; continue; }
    if (char !== '<' && char !== '>') { text += char; continue; }
    text = text.replace(/(^|\s)\d+$/, '$1') + ' ';
    while (segment[index + 1] === char || segment[index + 1] === '&') index += 1;
    while (segment[index + 1] === ' ' || segment[index + 1] === '\t') index += 1;
    if (segment[index + 1] === '"' || segment[index + 1] === "'") {
      const marker = segment[++index];
      while (index + 1 < segment.length && segment[index + 1] !== marker) index += 1;
      if (segment[index + 1] === marker) index += 1;
    } else {
      while (index + 1 < segment.length && !/[\s;|&()<>]/.test(segment[index + 1])) index += 1;
    }
  }
  return shellWords(text);
}

/** Ordered command and scope events; substitutions stay attached until their host command executes. */
function splitCommandText(command) {
  const events = [];
  let text = '';
  let quote = null;
  let substitutions = [];
  const finish = () => {
    if (text.trim() || substitutions.length) events.push({ kind: 'command', text: text.trim(), substitutions });
    text = '';
    substitutions = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      const pair = command.slice(index, index + 2);
      if (quote === '"' && command.slice(index, index + 3) === '$((') {
        const end = arithmeticEnd(command, index);
        substitutions.push(...arithmeticSubstitutions(command, index, end));
        text += '0';
        index = end;
        continue;
      }
      if (quote === '"' && pair === '$(') {
        const substitution = commandSubstitution(command, index + 2, ')');
        if (substitution.text.trim()) substitutions.push(substitution.text.trim());
        index = substitution.end;
        continue;
      }
      if (quote === '"' && char === '`') {
        const substitution = commandSubstitution(command, index + 1, '`');
        if (substitution.text.trim()) substitutions.push(substitution.text.trim());
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
    if (command.slice(index, index + 3) === '$((') {
      const end = arithmeticEnd(command, index);
      substitutions.push(...arithmeticSubstitutions(command, index, end));
      text += '0';
      index = end;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === '$(' || char === '`') {
      const substitution = commandSubstitution(command, index + (pair === '$(' ? 2 : 1), pair === '$(' ? ')' : '`');
      if (substitution.text.trim()) substitutions.push(substitution.text.trim());
      index = substitution.end;
      continue;
    }
    if (pair === '&&' || pair === '||') { finish(); events.push({ kind: 'separator' }); index += 1; continue; }
    if (char === '(') { finish(); events.push({ kind: 'open' }); continue; }
    if (char === ')') { finish(); events.push({ kind: 'close' }); continue; }
    if (char === '|') { finish(); events.push({ kind: 'pipe' }); continue; }
    if (char === '&' && (command[index - 1] === '>' || command[index - 1] === '<')) {
      text += char; continue;
    }
    if (';&\n'.includes(char)) { finish(); events.push({ kind: 'separator' }); continue; }
    text += char;
  }
  finish();
  return events;
}

/** Find the closing arithmetic expansion so its shift operator is never read as a heredoc. */
function arithmeticEnd(command, start) {
  let depth = 2;
  for (let index = start + 3; index < command.length; index += 1) {
    if (command[index] === '(') depth += 1;
    else if (command[index] === ')' && --depth === 0) return index;
  }
  return command.length - 1;
}

function arithmeticSubstitutions(command, start, end) {
  const nested = [];
  for (let index = start + 3; index < end; index += 1) {
    const pair = command.slice(index, index + 2);
    if (pair === '$(' || command[index] === '`') {
      const value = commandSubstitution(command, index + (pair === '$(' ? 2 : 1), pair === '$(' ? ')' : '`');
      if (value.text.trim()) nested.push(value.text.trim());
      index = value.end;
    }
  }
  return nested;
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

/** Remove here-document data while retaining substitutions that an unquoted delimiter executes. */
function withoutHeredocBodies(command) {
  const pending = [];
  const output = [];
  let quote = null;
  for (const line of command.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (pending.length) {
      const current = pending[0];
      const body = line.replace(/\n$/, '');
      const delimiterLine = current.stripTabs ? body.replace(/^\t+/, '') : body;
      if (delimiterLine === current.delimiter) pending.shift();
      else if (!current.quoted) {
        for (const executable of heredocSubstitutions(body)) {
          const insertion = ` $(${executable})`;
          const owner = output[current.ownerIndex];
          output[current.ownerIndex] = owner.slice(0, current.insertionIndex) + insertion
            + owner.slice(current.insertionIndex);
          for (const marker of pending) {
            if (marker.ownerIndex === current.ownerIndex && marker.insertionIndex >= current.insertionIndex) {
              marker.insertionIndex += insertion.length;
            }
          }
        }
      }
      if (line.endsWith('\n')) output.push('\n');
      continue;
    }
    let visible = line;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quote) {
        if (char === '\\' && quote === '"') { index += 1; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (line.slice(index, index + 3) === '$((') { index = arithmeticEnd(line, index); continue; }
      if (char === '#' && (index === 0 || /[\s;|&()]/.test(line[index - 1]))) {
        visible = line.slice(0, index) + (line.endsWith('\n') ? '\n' : '');
        break;
      }
      if (char === '\\') { index += 1; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (line.slice(index, index + 2) !== '<<' || line[index + 2] === '<') continue;
      let cursor = index + 2;
      const stripTabs = line[cursor] === '-';
      if (stripTabs) cursor += 1;
      while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
      let delimiter = '';
      let markerQuote = null;
      let quoted = false;
      while (cursor < line.length) {
        const marker = line[cursor];
        if (markerQuote) {
          if (marker === markerQuote) { markerQuote = null; cursor += 1; continue; }
          if (marker === '\\' && markerQuote === '"' && cursor + 1 < line.length) {
            delimiter += line[cursor + 1]; cursor += 2; continue;
          }
          delimiter += marker; cursor += 1; continue;
        }
        if (/[\s;|&()<>]/.test(marker)) break;
        if (marker === "'" || marker === '"') { markerQuote = marker; quoted = true; cursor += 1; continue; }
        if (marker === '\\' && cursor + 1 < line.length) {
          delimiter += line[cursor + 1]; quoted = true; cursor += 2; continue;
        }
        delimiter += marker; cursor += 1;
      }
      if (delimiter && !markerQuote) {
        pending.push({ delimiter, stripTabs, quoted, ownerIndex: output.length, insertionIndex: cursor });
        index = cursor - 1;
      }
    }
    output.push(visible);
  }
  return normalizeContinuations(output.join(''));
}

/** Remove shell line continuations after heredoc data has already been discarded. */
function normalizeContinuations(command) {
  let text = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\' && command[index + 1] === '\n' && quote !== "'") { index += 1; continue; }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
    }
    text += char;
  }
  return text;
}

function heredocSubstitutions(body) {
  const commands = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\') { index += 1; continue; }
    const pair = body.slice(index, index + 2);
    if (pair === '$(' || body[index] === '`') {
      const substitution = commandSubstitution(body, index + (pair === '$(' ? 2 : 1), pair === '$(' ? ')' : '`');
      if (substitution.text.trim()) commands.push(substitution.text);
      index = substitution.end;
    }
  }
  return commands;
}

/** Expand executable wrappers in their own scope, while eval retains the caller's scope. */
function expandSegment(segment, depth, expandShellPayloads, remote, scope, childScope,
  substitutions, inheritedSubstitution, functions, functionStack) {
  const hasSubstitution = inheritedSubstitution || substitutions.length > 0;
  const words = commandWords(segment);
  const prefix = commandPrefix(words);
  const current = words.slice(prefix.index);
  const controls = [];
  while (CONTROL.has(current[0])) controls.push(current.shift());
  const moved = prefix.chdir === undefined ? {} : { chdir: prefix.chdir };
  const entry = (extra = {}) => ({ env: prefix.env, words: current, controls, remote, scope, hasSubstitution,
    substitutions, ...moved, ...extra });
  if (current.length === 0) return controls.length || Object.keys(prefix.env).length
    ? [entry()] : [];
  if (!expandShellPayloads) return [entry()];
  const program = path.basename(current[0]);
  if (functions.has(program)) {
    if (functionStack.includes(program)) return [];
    return expandCommand(functions.get(program), depth, true, remote, scope, childScope,
      hasSubstitution, functions, [...functionStack, program]);
  }
  if (program === 'ssh') {
    let index = 1;
    while (current[index]?.startsWith('-')) {
      const option = current[index++];
      if (option === '--') break;
      if (SSH_VALUED.has(option)) index += 1;
    }
    index += 1;
    const payload = current.slice(index).join(' ');
    return payload ? expandCommand(payload, depth + 1, true, true, childScope(scope), childScope,
      hasSubstitution, new Map(), [])
      : [entry()];
  }
  if (SHELLS.has(program)) {
    let index = 1;
    let executes = false;
    while (/^[-+]/.test(current[index] ?? '')) {
      const option = current[index++];
      if (/c/.test(option.replace(/^[-+]+/, ''))) executes = true;
      if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(option)) index += 1;
    }
    if (executes) {
      const payload = current[index] ?? '';
      if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(payload)
        || (!payload && substitutions.length)) {
        return [entry({ wrapperPayload: payload, wrapper: program })];
      }
      // A shell started by env -C or sudo -D begins elsewhere; callers cannot prove a cwd inside it.
      if (payload) return expandCommand(payload, depth + 1, true, remote,
        childScope(scope), childScope, hasSubstitution, new Map(), [])
        .map((nested) => prefix.chdir === undefined ? nested : { ...nested, chdirPayload: prefix.chdir });
    }
  }
  if (program === 'eval' && (current.length > 1 || substitutions.length)) {
    const payload = current.slice(current[1] === '--' ? 2 : 1).join(' ');
    if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(payload)
      || (!payload && substitutions.length)) {
      return [entry({ evalPayload: payload })];
    }
    return payload ? expandCommand(payload, depth + 1, true, remote, scope, childScope,
      hasSubstitution, functions, functionStack) : [];
  }
  return [entry()];
}

/** Replace literal function definitions with ordered registration markers, never executed bodies. */
function extractFunctions(command) {
  if (!/\bfunction\b|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/.test(command)) {
    return { text: command, definitions: [] };
  }
  const definitions = [];
  let text = '';
  let quote = null;
  let comment = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (comment) {
      text += char;
      if (char === '\n') comment = false;
      continue;
    }
    if (quote) {
      text += char;
      if (char === '\\' && quote === '"' && index + 1 < command.length) text += command[++index];
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) { text += char + command[++index]; continue; }
    if (char === "'" || char === '"') { quote = char; text += char; continue; }
    if (char === '#' && (index === 0 || /[\s;|&(){}]/.test(command[index - 1]))) {
      comment = true; text += char; continue;
    }
    if (!/[A-Za-z_]/.test(char)) { text += char; continue; }
    const boundary = Math.max(...[';', '|', '&', '\n', '(', '{'].map((marker) => text.lastIndexOf(marker)));
    const commandStart = text.slice(boundary + 1).trim() === '';
    const signature = commandStart
      ? /^(?:function[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*\([ \t]*\))?|([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([ \t]*\))[ \t]*\{/.exec(command.slice(index))
      : null;
    if (signature) {
      const open = index + signature[0].length - 1;
      const close = functionBraceEnd(command, open);
      if (close >= 0) {
        const number = definitions.push({ name: signature[1] ?? signature[2], body: command.slice(open + 1, close) }) - 1;
        text += ` __VIBE_FUNC_DEF_${number}__ `;
        index = close;
        continue;
      }
    }
    text += char;
  }
  return { text, definitions };
}

function functionBraceEnd(command, open) {
  let depth = 1;
  let quote = null;
  for (let index = open + 1; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\\') { index += 1; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return index;
  }
  return -1;
}

/** Emit execution order and isolate command substitutions, parentheses and pipeline stages. */
function expandCommand(command, depth, expandShellPayloads, remote, rootScope, childScope,
  inheritedSubstitution = false, functions = new Map(), functionStack = []) {
  if (depth > MAX_NESTED_SHELL_DEPTH) return [{ env: {}, words: [], controls: [], remote,
    scope: rootScope, hasSubstitution: inheritedSubstitution, substitutions: [],
    unresolvedExecutable: 'nested shell expansion depth exceeded' }];
  const extracted = extractFunctions(withoutHeredocBodies(command));
  const events = splitCommandText(extracted.text);
  const scopes = [rootScope];
  const functionScopes = [functions];
  const segments = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.kind === 'open') {
      scopes.push(childScope(scopes.at(-1)));
      functionScopes.push(new Map(functionScopes.at(-1)));
      continue;
    }
    if (event.kind === 'close') {
      if (scopes.length > 1) { scopes.pop(); functionScopes.pop(); }
      continue;
    }
    if (event.kind !== 'command') continue;
    const parent = scopes.at(-1);
    const pipeline = events[index - 1]?.kind === 'pipe' || events[index + 1]?.kind === 'pipe';
    const scope = pipeline ? childScope(parent) : parent;
    const visibleFunctions = pipeline ? new Map(functionScopes.at(-1)) : functionScopes.at(-1);
    const definition = /^__VIBE_FUNC_DEF_(\d+)__$/.exec(event.text);
    if (definition) {
      const entry = extracted.definitions[Number(definition[1])];
      if (entry) visibleFunctions.set(entry.name, entry.body);
      continue;
    }
    for (const payload of event.substitutions) {
      segments.push(...expandCommand(payload, depth + 1, true, remote, childScope(scope), childScope,
        false, new Map(visibleFunctions), functionStack));
    }
    segments.push(...expandSegment(event.text, depth, expandShellPayloads, remote, scope, childScope,
      event.substitutions, inheritedSubstitution, visibleFunctions, functionStack));
  }
  return segments;
}

/** Ordered executable commands with child scope and remote metadata for the guards. */
export function commandSegments(command, { expandShellPayloads = false } = {}) {
  let sequence = 0;
  const childScope = (parent) => `${parent}/${++sequence}`;
  return expandCommand(command, 0, expandShellPayloads, false, 'root', childScope);
}
