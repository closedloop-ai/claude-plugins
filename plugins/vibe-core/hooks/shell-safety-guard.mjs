// PreToolUse guard for Bash: workers may not invent credential routes to fetch
// evidence or force-push any remote. Both mistakes can escape a written rule,
// especially through an ssh command aimed at another machine.
// Three more refusals, each from a written rule that was skipped (2026-10-23/24):
// the fleet watcher started with `&` or inside a compound command detached and
// held its lock while its events never arrived; `set -- $var` in a merge watcher
// never fired, because zsh (this tool's shell on macOS) does not word-split an
// unquoted parameter; and a machine's shared e2e slot wrapper (the bound
// provider's `data.guards.e2eSlot` rule) reran tests on an old commit when a run
// started before the push landed, because the slot captured whatever HEAD was.
// And `echo ====` (2026-10-22): zsh expands an unquoted word starting with `=`
// to a command path, fails on `===`, and aborts the whole list, so the reads
// after it never ran and their absence was reported as a complete answer.
// Three more (2026-11-15): a verify worker committed a proof with --no-verify after a hook failed; a launcher
// worker told to delete its stale `e2e3.*` files also deleted the orchestrator's e2e3 launcher input and result
// beside them; and a remote worker ran the machine's own heavy slot wrapper, which checks no load (the bound
// provider's `data.guards.heavySlot` rule).

// Runs from pre-tool-use.mjs.

import path from "node:path";
import { commandPrefix, commandSegments } from "./command-segments.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { providerGuardRule, recordedBinding } from "../lib/vibe/scripts/provider.mjs";
import { launcherWorker } from "../lib/vibe/scripts/worker-scope.mjs";

const E2E_SCRIPT = /e2e/i;

const TOKEN = /(?:\b(?:gh_token|github_token|[a-z][a-z0-9_]*token)\b|\$\{?[a-z][a-z0-9_]*token\}?|--password(?:-stdin)?\b|(?:^|\s)-p(?:\s|$)|["']?auth["']?\s*:)/i;
const CREDENTIAL_ROUTE = /(?:\bDOCKER_CONFIG\b|\bdocker\s+login\b|["']?auths["']?\s*:)/i;
const SHELLS = new Set(["bash", "sh", "zsh"]);
const BACKGROUND_AMPERSAND = /&/;
const REDIRECT_AMPERSAND = /\d*>&\d*|&>>?/g;
const ZSH_SPLIT = /(?:^|[\s;&|(])set\s+--\s+\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?=[\s;&|)]|$)/m;
const SHA = /^[0-9a-f]{7,40}$/i;
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g;
const WORD_BREAK = new Set([" ", "\t", "\n", ";", "|", "&", "(", ")"]);
const COMMAND_BREAK = new Set(["\n", ";", "|", "&", "("]);
const ASSIGN_EQUALS = /^[A-Za-z_][A-Za-z0-9_]*==/;
// Raw text, so it also sees a push that no parsed segment executes, such as one in a heredoc fed to a remote shell.
const FORCE_PUSH = /\bgit\b(?:(?![;&|\n]).)*?\bpush\b(?:(?![;&|\n]).)*(?:\s-f(?:\s|$)|--force(?:-with-lease)?\b|(?:^|\s)\+[^\s]+)/i;
const NO_VERIFY = "--no-verify";
// git accepts an unambiguous abbreviation of a long option; `--no-veri` is the shortest that no other option shares.
const NO_VERIFY_ABBREVIATION = "--no-veri".length;
const HOOKS_PATH = /^core\.hookspath(?:=|$)/i;
// git's global options whose value may be the next word (git.c handle_options).
const GIT_VALUED_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);
/**
 * The option grammar (`git <command> -h`, git 2.56) of each command whose --no-verify skips hooks: `skipShort`, the
 * short flag that also means --no-verify (commit and am only; elsewhere -n is --dry-run or --no-stat), `valued` short
 * flags whose value is the rest of the word or else the next word, `attached` short flags whose optional value is only
 * the rest of the word, and `long` options whose value may be the next word.
 */
const GIT_OPTIONS = Object.freeze({
  commit: { skipShort: "n", valued: "mFCctU", attached: "Su", long: ["--file", "--author", "--date", "--message", "--reedit-message",
    "--reuse-message", "--fixup", "--squash", "--trailer", "--template", "--cleanup", "--unified", "--inter-hunk-context", "--pathspec-from-file"] },
  am: { skipShort: "n", valued: "Cp", attached: "S", long: ["--quoted-cr", "--whitespace", "--directory", "--exclude", "--include", "--patch-format"] },
  merge: { valued: "smXF", attached: "S", long: ["--cleanup", "--strategy", "--strategy-option", "--message", "--file", "--into-name"] },
  pull: { valued: "sXo", attached: "Sj", long: ["--cleanup", "--strategy", "--strategy-option", "--upload-pack", "--depth", "--shallow-since",
    "--shallow-exclude", "--deepen", "--refmap", "--server-option", "--negotiation-restrict", "--negotiation-tip", "--negotiation-include"] },
  push: { valued: "o", attached: "", long: ["--repo", "--receive-pack", "--exec", "--push-option"] },
  rebase: { valued: "CxsX", attached: "Sr", long: ["--onto", "--trailer", "--whitespace", "--exec", "--strategy", "--strategy-option"] },
});
const DELETERS = new Set(["rm", "unlink"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_MATCH = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex"]);
const FIND_PATTERN = /[*?[]/;

/** The credential-safety refusal for a shell command, or null. */
export function credentialProblem(command) {
  if (!CREDENTIAL_ROUTE.test(command) || !TOKEN.test(command)) return null;
  return "credential workaround refused: after the first authentication failure, use CI logs or the API for the same evidence, or stop and ask; never write, export or route around the operator's credentials";
}

/** The force-push refusal for a shell command, or null. */
export function forcePushProblem(command) {
  if (!FORCE_PUSH.test(command) && !commandSegments(command, { expandShellPayloads: true }).some(({ words }) => forcesPush(words))) return null;
  return "force push refused: never rewrite any remote, including another machine or a scratch ref; create a fresh proof/<sha>-<n> ref and push normally";
}

/** Whether `words` run `git push` with -f in any short-flag cluster, any --force option, or a `+` refspec. */
function forcesPush(words) {
  const call = gitCall(words);
  if (call?.command !== "push") return false;
  for (const option of gitOptions(call.args, GIT_OPTIONS.push)) {
    if (option.short === "f" || option.long?.startsWith("--force") || option.operand?.startsWith("+")) return true;
  }
  return false;
}

/** The refusal for a git call that skips its hooks (--no-verify, commit or am -n, or a core.hooksPath override), or null. */
export function noVerifyProblem(command) {
  for (const { words } of commandSegments(command, { expandShellPayloads: true })) {
    const call = gitCall(words);
    if (!call) continue;
    const grammar = Object.hasOwn(GIT_OPTIONS, call.command ?? "") ? GIT_OPTIONS[call.command] : null;
    const skips = call.settings.some((setting) => HOOKS_PATH.test(setting)) || (grammar !== null
      && [...gitOptions(call.args, grammar)].some(({ short, long }) => (short !== undefined && short === grammar.skipShort)
        || (long?.length >= NO_VERIFY_ABBREVIATION && NO_VERIFY.startsWith(long))));
    if (skips) {
      return "hook bypass refused (--no-verify, commit or am -n, core.hooksPath): a failing hook means the commit is not ready; fix the hook failure, then run the same git command with its hooks";
    }
  }
  return null;
}

/** A git call's subcommand and the words after it, with each `-c`/`--config-env` setting it passes; null when `words` run no git. */
function gitCall(words) {
  const start = invocationIndex(words);
  if (path.basename(words[start] ?? "") !== "git") return null;
  const settings = [];
  let index = start + 1;
  while (words[index]?.startsWith("-")) {
    const word = words[index++];
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    const name = equals < 0 ? word : word.slice(0, equals);
    if (!GIT_VALUED_GLOBALS.has(name)) continue;
    const value = equals < 0 ? words[index++] ?? "" : word.slice(equals + 1);
    if (name === "-c" || name === "--config-env") settings.push(value);
  }
  return { command: words[index] ?? null, args: words.slice(index + 1), settings };
}

/** Each of `args` under `grammar`: `{ short }` per short flag of a cluster, `{ long }` per long option, `{ operand }` otherwise; option values are skipped. */
function* gitOptions(args, grammar) {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === "--") {
      for (const operand of args.slice(index + 1)) yield { operand };
      return;
    }
    if (word.startsWith("--")) {
      const long = word.split("=", 1)[0];
      yield { long };
      if (!word.includes("=") && grammar.long.includes(long)) index += 1;
    } else if (word.startsWith("-") && word.length > 1) {
      for (let at = 1; at < word.length; at += 1) {
        const flag = word[at];
        if (grammar.attached.includes(flag)) break;
        if (grammar.valued.includes(flag)) {
          if (at === word.length - 1) index += 1;
          break;
        }
        yield { short: flag };
      }
    } else {
      yield { operand: word };
    }
  }
}

/**
 * The refusal for deleting by pattern: `rm` or `unlink` of a path the shell globs or brace-expands, or `find` deleting
 * (-delete, -exec rm) from a globbed start path or a wildcard -name/-path/-regex test; null for exact paths.
 */
export function globDeleteProblem(command) {
  for (const { words, globWords = new Set() } of commandSegments(command, { expandShellPayloads: true })) {
    const start = invocationIndex(words);
    const program = path.basename(words[start] ?? "");
    const args = words.slice(start + 1);
    const pattern = DELETERS.has(program) ? args.some((word) => globWords.has(word))
      : program === "find" && findDeletesByPattern(args, globWords);
    if (pattern) {
      return "delete by pattern refused: a worker deletes only exact paths it created, in its own per-worker directory; name each file, or remove that directory by its exact path";
    }
  }
  return null;
}

function findDeletesByPattern(args, globWords) {
  const deletes = args.some((word, index) => word === "-delete" || (FIND_EXEC.has(word) && DELETERS.has(path.basename(args[index + 1] ?? ""))));
  return deletes && args.some((word, index) => globWords.has(word) || (FIND_MATCH.has(args[index - 1]) && FIND_PATTERN.test(word)));
}

/** globDeleteProblem in a chat the vibe launcher started as a worker; an orchestrator owns its shared scratch and may clean it. */
function workerDeleteProblem(event, command) {
  const problem = globDeleteProblem(command);
  return problem && launcherWorker(event?.session_id) ? problem : null;
}

/** The refusal for a fleet watcher launch that is not its own background tool call, or null. */
export function watcherLaunchProblem(input) {
  const command = typeof input?.command === "string" ? input.command.replace(REDIRECT_AMPERSAND, " ") : "";
  const segments = commandSegments(command).filter(({ words }) => words.length > 0);
  if (!segments.some(({ words }) => invokes(words, "watch.sh"))) return null;
  if (input.run_in_background === true && segments.length === 1 && !BACKGROUND_AMPERSAND.test(command)) return null;
  return "start watch.sh only as its own Bash call with run_in_background, never with & or inside a compound command: a detached copy never reports to you and holds the lock (stop one with kill-guard.mjs own <pid>, then kill <pid>)";
}

/** The refusal for `set -- $var`, which splits nothing in zsh, or null. */
export function wordSplitProblem(command) {
  if (!ZSH_SPLIT.test(command)) return null;
  return "set -- $var does not word-split in zsh, so $1 holds the whole string: use read -r first second <<< \"$var\"";
}

/** The refusal for an unquoted word starting with `=` outside `[[ ]]`, which aborts a zsh command list, or null. */
export function equalsWordProblem(command) {
  for (const { word, commandPosition, testDepth } of unquotedWords(command.replace(HEREDOC, " "))) {
    if (testDepth === 0 && ((word.length > 1 && word.startsWith("=")) || (commandPosition && ASSIGN_EQUALS.test(word)))) {
      return `zsh reads the unquoted ${word} as an =command lookup, which fails and aborts the rest of the command list: quote it ('${word}') or use printf '%s\\n' '${word}'`;
    }
  }
  return null;
}

/** Each word's unquoted text, with whether it starts a command and the `[[ ]]` depth it sits in. */
function unquotedWords(command) {
  const words = [];
  let word = null;
  let quote = null;
  let commandPosition = true;
  let testDepth = 0;
  const finish = () => {
    if (word === null) return;
    if (word.quoted === false && word.text === "[[") testDepth += 1;
    else if (word.quoted === false && word.text === "]]") testDepth = Math.max(0, testDepth - 1);
    else if (word.quoted === false) words.push({ word: word.text, commandPosition: word.commandPosition, testDepth });
    commandPosition = word.commandPosition && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text);
    word = null;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') index += 1;
      continue;
    }
    if (WORD_BREAK.has(char)) {
      finish();
      if (COMMAND_BREAK.has(char)) commandPosition = true;
      continue;
    }
    word ??= { text: "", quoted: false, commandPosition };
    if (char === "'" || char === '"') {
      word.quoted = true;
      quote = char;
    } else if (char === "\\") {
      word.quoted = true;
      index += 1;
    } else if (!word.quoted) {
      word.text += char;
    }
  }
  finish();
  return words;
}

// Resolve leading shells (including combined -lic/-c options) and ssh's remote
// command, without treating quoted printf/cat arguments as executable commands.
function invocationIndex(words) {
  let index = 0;
  for (;;) {
    index = commandPrefix(words, index).index;
    if (path.basename(words[index] ?? '') === 'ssh') {
      index += 1;
      while (words[index]?.startsWith('-')) {
        const flag = words[index++];
        if (['-p', '-i', '-o', '-J', '-F', '-l', '-S', '-W', '-L', '-R', '-D', '-b'].includes(flag)) index += 1;
      }
      index += 1; // remote host
    } else if (SHELLS.has(path.basename(words[index] ?? ''))) {
      index += 1;
      while (/^[-+]/.test(words[index] ?? '')) {
        const option = words[index++];
        if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(option)) index += 1;
      }
    } else {
      return index;
    }
  }
}

/**
 * Require the deployed slot wrapper's real `<headFlag> <sha> <owner> <command>` interface, under `rule` (the bound
 * provider's `data.guards.e2eSlot`: the wrapper's name, its head flag and the flags it refuses); none without one.
 */
export function e2eSlotProblem(command, rule) {
  if (!rule?.script) return null;
  for (const { words } of commandSegments(command, { expandShellPayloads: true })) {
    const start = invocationIndex(words);
    if (path.basename(words[start] ?? "") !== rule.script) continue;
    if (words[start + 1] !== rule.headFlag || !SHA.test(words[start + 2] ?? '')) {
      return `${rule.script} needs ${rule.headFlag} <sha> before the owner label, the committed HEAD underlying the tested source`;
    }
    const refused = (rule.refusedFlags ?? []).find((flag) => words[start + 3] === flag);
    if (refused) {
      return `${rule.script} does not accept ${refused}; it would treat that flag as the owner label and execute the hash as a command`;
    }
  }
  return null;
}

/**
 * Refuse any invocation of a machine's ungated heavy slot wrapper, under `rule` (the bound provider's
 * `data.guards.heavySlot`: the wrapper names to refuse and the load-gated command to use instead); none without one.
 */
export function heavySlotProblem(command, rule) {
  if (!rule?.refusedScripts?.length) return null;
  for (const { words } of commandSegments(command, { expandShellPayloads: true })) {
    const script = path.basename(words[invocationIndex(words)] ?? "");
    if (rule.refusedScripts.includes(script)) {
      return `${script} takes a heavy slot with no load check, so it is refused: run heavy work through ${rule.gatedCommand}, which refuses a loaded machine`;
    }
  }
  return null;
}

function invokes(words, script) {
  return path.basename(words[invocationIndex(words)] ?? '') === script;
}

/** The PreToolUse result for a Bash call: a deny for the first unsafe shape it finds, or null. */
export function shellSafetyGuard(event) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return null;
  const rule = providerRules(event);
  const problem = credentialProblem(command) ?? forcePushProblem(command) ?? noVerifyProblem(command)
    ?? watcherLaunchProblem(event.tool_input) ?? wordSplitProblem(command) ?? equalsWordProblem(command)
    ?? workerDeleteProblem(event, command) ?? e2eSlotProblem(command, rule("e2eSlot")) ?? heavySlotProblem(command, rule("heavySlot"));
  return problem ? deny(problem) : null;
}

/**
 * Whether `event` runs a script named for e2e: with the bound provider broken, its slot wrapper's name cannot be read,
 * so the dispatcher refuses every such command rather than run one unchecked.
 */
export function runsE2eScript(event) {
  const command = event?.tool_input?.command;
  if (typeof command !== "string") return false;
  return commandSegments(command, { expandShellPayloads: true })
    .some(({ words }) => E2E_SCRIPT.test(path.basename(words[invocationIndex(words)] ?? "")));
}

/**
 * A reader of the bound provider's guard rules for this event's chat (its session worktree, then the chat): each key's
 * rule, or null. The binding is read once, on the first key asked for.
 */
function providerRules(event) {
  let binding;
  return (key) => {
    binding ??= { value: recordedBinding({ worktree: eventCwd(event), conversation: event?.session_id ?? null }) };
    return providerGuardRule(binding.value, key);
  };
}
