#!/usr/bin/env node
// Refuses a screenshot capture that repeats a ticket's main baseline or is too
// big (ISS-14158). One ticket's proof scripts once ran more than 30 capture
// runs through the fleet heavy slot in a day, re-shooting main after every
// main merge; one run was 1632 shots. This guard only ever refuses a capture;
// nothing here asks for one (`../references/quality-loop-visual-qa.md`, block
// `when-to-capture`, says when a capture is justified).
//
// Usage:
//   capture-guard.mjs facts --repo <worktree> --ref <ref>
//   capture-guard.mjs begin --spec <spec.json> (--repo <worktree> | --facts <facts JSON>)
//                     [--ledger <dir>] [--owner <label>] [--pid <owning process>] [--rulings <file>]
//   capture-guard.mjs end --ticket <slug> --id <entry id> --status <exit code> [--seconds <n>]
//                     (--ledger <dir> | --repo <worktree>)
//   capture-guard.mjs status --ticket <slug> (--ledger <dir> | --repo <worktree>)
//
// The spec is {"ticket", "ref", "pages", "states", "override"?}; the caller
// declares the page and state counts, the only place those numbers exist.
// `override` is {"quote": <operator words>}, matched in the file `begin --rulings`
// names (fleet.sh passes the program's rulings.md; the spec cannot redirect it)
// with rulings-check.mjs's own matchers. A Ruling line overrides a refusal only when it names the ticket, quotes the operator's words, and carries `capture-guard override: baseline` or `capture-guard override: budget` for the kind of refusal it lifts.
// baseline lifts the repeated and the second main baseline refusals, budget
// the shot and minute refusals; a capture that meets both needs both markers,
// on one qualifying line or across several with the same quoted words.
// The override shape is fixed: the decision text after `Ruling ... (<source>):`
// begins with the one double-quoted span holding the operator's words, and the
// ticket and the marker follow its closing quote; any other shape counts for nothing.
//
// `begin` refuses (exit 79), in order:
//   - a main commit already captured for the ticket;
//   - any second main baseline for the ticket (one per ticket, never retaken
//     because main moved);
//   - more than CAPTURE_BUDGET.maxShots shots (pages times states);
//   - more than CAPTURE_BUDGET.maxMinutes at the higher of the floor rate and
//     the slowest seconds per shot this ticket's finished captures measured;
//   - a ref it cannot resolve, or a worktree with no origin default branch.
// A main commit is an ancestor of refs/remotes/origin/HEAD (else
// refs/remotes/origin/main) in the capture worktree; a commit that merged main
// into the branch is a branch commit. A stale origin ref on the capture host
// can make a new main commit look like a branch commit.
//
// The ledger is <ledger>/<ticket>.json. fleet.sh passes <orchDir>/captures,
// so a capture on either machine is seen; without --ledger it is
// the ledger of the fleet program whose board.json lists this clone as a
// writer worktree (programs are found from FLEET_HOME and the fleet chat
// bindings under ~/.vibe-hook-scope/fleet-binding, and exactly one must match),
// else <git common dir>/vibe-captures of --repo, or of the current directory
// when neither is given, one per clone and machine. With both --ledger and --repo
// (fleet.sh on the local machine) the two ledgers mirror each other: refusals
// read both and each entry is written to both, so a direct capture in that
// clone and a fleet capture see each other. A remote fleet capture is
// recorded only in <orchDir>/captures. `begin` appends a
// running entry and `end` marks it ok (exit 0) or failed, once: `end` refuses
// an entry that is no longer running. A running entry counts while its owning
// process lives or until its own estimated minutes, never fewer than the
// budget's, have passed since it began, so a direct call whose shell exits at
// once still holds its place, and a killed run frees it after that bound.
// fleet.sh times the command inside the slot and passes `end --seconds`, which
// sets the measured rate. `--facts` (a remote worktree's facts) is trusted as
// given. A direct caller can name any file through `--rulings`: the guard cannot verify that a local file is the program rulings or the ticket body; fleet.sh always passes the program rulings.
// Usage errors exit 2.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const CAPTURE_BUDGET = Object.freeze({ maxShots: 240, maxMinutes: 20, floorSecondsPerShot: 5 });
const REFUSED_EXIT = 79;
const USAGE_EXIT = 2;
const EntryStatus = Object.freeze({ Running: "running", Ok: "ok", Failed: "failed" });

const TICKET = /^[A-Z]+-\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const SPEC_KEYS = new Set(["ticket", "ref", "pages", "states", "override"]);
const OVERRIDE_MARKER = /capture-guard override: (baseline|budget)\b/g;
const RefusalKind = Object.freeze({ Baseline: "baseline", Budget: "budget" });
const FLEET_BINDINGS = path.join(".vibe-hook-scope", "fleet-binding");
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const USAGE = "Usage: capture-guard.mjs facts|begin|end|status (see the header of capture-guard.mjs)";

class CaptureRefusal extends Error {}
class CaptureUsageError extends Error {}

const refused = (text) => new CaptureRefusal(`capture-guard: refused: ${text}`);
const overridable = (ticket) => ` An operator ruling recorded for ${ticket} overrides this through the spec's override.`;
const invalid = (field) => new CaptureUsageError(`capture-guard: invalid ${field}\n${USAGE}`);

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitStatus(repo, args) {
  try {
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    return 0;
  } catch (error) {
    return typeof error.status === "number" ? error.status : -1;
  }
}

/** The capture ref's commit and whether it is a main commit, read from the capture worktree. */
function captureFacts(repo, ref) {
  const cannotTell = () => refused(`cannot tell whether ${ref} is a main commit in ${repo}: no origin default branch.`);
  let sha;
  let defaultRef;
  try {
    sha = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    throw cannotTell();
  }
  try {
    defaultRef = git(repo, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  } catch {
    defaultRef = "refs/remotes/origin/main";
  }
  if (gitStatus(repo, ["rev-parse", "--verify", "--quiet", `${defaultRef}^{commit}`]) !== 0) throw cannotTell();
  const ancestor = gitStatus(repo, ["merge-base", "--is-ancestor", sha, defaultRef]);
  if (ancestor !== 0 && ancestor !== 1) throw cannotTell();
  return { sha, main: ancestor === 0, defaultRef };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/** The checked capture spec, or a usage error naming the bad field. */
function parseSpec(text) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch {
    throw invalid("spec");
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw invalid("spec");
  for (const key of Object.keys(spec)) if (!SPEC_KEYS.has(key)) throw invalid(`spec key ${key}`);
  if (typeof spec.ticket !== "string" || !TICKET.test(spec.ticket)) throw invalid("ticket");
  if (typeof spec.ref !== "string" || !spec.ref.trim()) throw invalid("ref");
  if (!positiveInteger(spec.pages)) throw invalid("pages");
  if (!positiveInteger(spec.states)) throw invalid("states");
  if (spec.override !== undefined) {
    const { override } = spec;
    if (!override || typeof override !== "object" || Array.isArray(override)
      || Object.keys(override).some((key) => key !== "quote")
      || typeof override.quote !== "string" || !override.quote.trim()) {
      throw invalid("override");
    }
  }
  return spec;
}

function parseFacts(text) {
  let facts;
  try {
    facts = JSON.parse(text);
  } catch {
    throw invalid("facts");
  }
  if (!facts || typeof facts.sha !== "string" || !SHA.test(facts.sha) || typeof facts.main !== "boolean") throw invalid("facts");
  return { sha: facts.sha, main: facts.main, defaultRef: facts.defaultRef };
}

/** Whether a recorded owning process still runs; a probe only, nothing is signalled. */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Whether a running entry still holds its place: a live owner, or younger than its own estimate (never under the budget). */
function stillRunning(entry, alive, now, budget = CAPTURE_BUDGET) {
  if (entry.status !== EntryStatus.Running) return false;
  if (alive(entry.pid)) return true;
  const minutes = Math.max(budget.maxMinutes, Number.isFinite(entry.estimatedMinutes) ? entry.estimatedMinutes : 0);
  const started = Date.parse(entry.startedAt);
  return !Number.isFinite(started) || now.getTime() - started < minutes * 60_000;
}

/** Entries that hold a place in the ledger: finished ok, or still running. */
function countedEntries(ledger, alive = processAlive, now = new Date()) {
  return ledger.captures.filter((entry) => entry.status === EntryStatus.Ok || stillRunning(entry, alive, now));
}

/** The slowest seconds per shot among the ticket's finished captures that measured their time, or null. */
function measuredSecondsPerShot(ledger) {
  const rates = ledger.captures
    .filter((entry) => entry.status === EntryStatus.Ok && Number.isFinite(entry.seconds) && entry.seconds > 0 && entry.shots > 0)
    .map((entry) => entry.seconds / entry.shots);
  return rates.length ? Math.max(...rates) : null;
}

/**
 * A ruling line's fixed override shape, or null: a Ruling record line (rulings-check.mjs's `recordRulings`) whose decision
 * text, everything after the source parenthesis (the first `)` immediately followed by `:`, so a source such as
 * `ticket: ISS-1` or a `~07:10Z` time keeps its colons), begins with the one ASCII double-quoted span holding the
 * operator's words, and the line has exactly
 * two ASCII double quotes and no curly double quotes (U+201C, U+201D). Any other shape is ambiguous (operator words in
 * other quote marks can carry an ASCII-quoted phrase, a ticket and a marker) and counts for nothing. `inside` is the
 * span's trimmed content; `after` is the text after its closing quote, where the ticket and the marker must appear.
 */
function rulingSpan(line, recordRulings) {
  if (/[\u201C\u201D]/.test(line) || (line.match(/"/g) ?? []).length !== 2) return null;
  if (recordRulings(line).length === 0) return null;
  const close = line.indexOf("):");
  const decision = close === -1 ? undefined : line.slice(close + 2).trimStart();
  const match = decision === undefined ? null : /^"([^"]*)"(.*)$/.exec(decision);
  return match ? { inside: match[1].trim(), after: match[2] } : null;
}

/**
 * The override kinds `rulings` grants: every marker on the ruling lines in the fixed shape (`rulingSpan`) whose quoted
 * span holds the spec's quote as its whole content and whose text after that span names the ticket by its exact slug.
 * The ticket and the markers count only after the quoted span; any other line counts for nothing, so operator words
 * that themselves contain double quotes never match. `matched` is false when no such line exists. Imported dynamically,
 * so it loads only when an override is checked; ship-plugins.mjs still follows the import, so a remote host receives
 * rulings-check.mjs and its imports too.
 */
async function findOverride(override, ticket, rulings) {
  const quote = override.quote.trim();
  const none = { rulings: rulings ?? "--rulings", quote, matched: false, kinds: new Set() };
  if (!rulings) return none;
  let text;
  try {
    text = readFileSync(rulings, "utf8");
  } catch {
    return none;
  }
  const { recordRulings, rulingNamesScope } = await import("../../handoff/scripts/rulings-check.mjs");
  // Lines split exactly where recordRulings' multiline matcher breaks them, so a line means the same thing to both.
  const matches = text.split(/\r\n|[\n\r\u2028\u2029]/).map((line) => rulingSpan(line, recordRulings))
    .filter((span) => span !== null && span.inside === quote && rulingNamesScope(span.after, [ticket]));
  const kinds = new Set(matches.flatMap((span) => [...span.after.matchAll(OVERRIDE_MARKER)].map((match) => match[1])));
  return { rulings, quote, matched: matches.length > 0, kinds };
}

/** The refusal to raise when `found` does not lift every kind in `refusals`, or null when it lifts them all. */
function overrideRefusal(found, refusals, ticket) {
  if (!found || !found.matched) {
    return refused(`${found?.rulings ?? "--rulings"} has no Ruling line naming ${ticket} with those quoted words; only an operator ruling recorded for this ticket overrides a refusal.`);
  }
  const missing = refusals.find((refusal) => !found.kinds.has(refusal.kind));
  return missing ? refused(`${found.rulings} has a Ruling line for ${ticket} with those quoted words, but it does not carry \`capture-guard override: ${missing.kind}\` for this refusal.`) : null;
}

/**
 * The refusals a capture meets against the ticket's ledger, in rule order. An
 * empty list admits it. `alive` decides whether a running entry still counts.
 */
function captureRefusals(spec, facts, ledger, { alive = processAlive, budget = CAPTURE_BUDGET, now = new Date() } = {}) {
  const { ticket, pages, states } = spec;
  const refusals = [];
  if (facts.main) {
    const baselines = countedEntries(ledger, alive, now).filter((entry) => entry.main);
    if (baselines.some((entry) => entry.sha === facts.sha)) {
      refusals.push({ kind: RefusalKind.Baseline, text: `${facts.sha} is a main commit already captured for ${ticket}; reuse that baseline.${overridable(ticket)}` });
    } else if (baselines.length > 0) {
      refusals.push({ kind: RefusalKind.Baseline, text: `${ticket} already has its main baseline at ${baselines[0].sha}; one main baseline per ticket, never retaken because main moved.${overridable(ticket)}` });
    }
  }
  const shots = pages * states;
  if (shots > budget.maxShots) {
    refusals.push({ kind: RefusalKind.Budget, text: `${pages} pages x ${states} states is ${shots} shots, over the ${budget.maxShots} shot budget for one capture; capture only the states the change can reach.${overridable(ticket)}` });
  }
  const rate = Math.max(budget.floorSecondsPerShot, measuredSecondsPerShot(ledger) ?? 0);
  const seconds = shots * rate;
  if (seconds > budget.maxMinutes * 60) {
    const shown = Number(rate.toFixed(1));
    refusals.push({ kind: RefusalKind.Budget, text: `${shots} shots at ${shown} s each is about ${Math.ceil(seconds / 60)} minutes, over the ${budget.maxMinutes} minute budget for one capture; capture only the states the change can reach.${overridable(ticket)}` });
  }
  return { refusals, shots, estimatedMinutes: Math.ceil(seconds / 60) };
}

/** `<program>/captures` when exactly one known fleet program's board lists `repo`'s worktree as a writer's, else null. */
async function fleetLedgerFor(repo, env = process.env) {
  let top;
  try {
    top = realpathSync(git(repo, ["rev-parse", "--show-toplevel"]));
  } catch {
    return null;
  }
  const { vibeCore } = await import("../../../shared/vibe-core.mjs");
  const { canonicalHome } = await vibeCore("lib/fleet-orchestrator/scripts/chat-binding.mjs");
  const programs = new Set();
  const listDir = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  // One home, however it is spelled (a symlink or a relative FLEET_HOME), is one set of programs.
  if (env.FLEET_HOME) {
    const home = canonicalHome(env.FLEET_HOME);
    for (const name of listDir(path.join(home, "programs"))) programs.add(path.join(home, "programs", name));
  }
  const bindings = path.join(env.HOME || os.homedir(), FLEET_BINDINGS);
  for (const name of listDir(bindings).filter((file) => file.endsWith(".json"))) {
    try {
      const binding = JSON.parse(readFileSync(path.join(bindings, name), "utf8"));
      if (typeof binding?.home === "string" && typeof binding.program === "string") programs.add(path.join(canonicalHome(binding.home), "programs", binding.program));
    } catch { /* not a binding */ }
  }
  const same = (worktree) => {
    try {
      return realpathSync(worktree) === top;
    } catch {
      return false;
    }
  };
  const matches = [...programs].filter((dir) => {
    try {
      const board = JSON.parse(readFileSync(path.join(dir, "board.json"), "utf8"));
      return Object.values(board?.writers ?? {}).some((writer) => typeof writer?.worktree === "string" && same(writer.worktree));
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? path.join(matches[0], "captures") : null;
}

function defaultLedgerDir(repo) {
  const common = git(repo, ["rev-parse", "--git-common-dir"]);
  return path.join(path.resolve(repo, common), "vibe-captures");
}

function ledgerFile(dir, ticket) {
  if (!TICKET.test(ticket)) throw invalid("ticket");
  return path.join(dir, `${ticket}.json`);
}

/** The ticket's ledger; a missing file is an empty history and a symlinked one is refused. */
function readLedger(dir, ticket) {
  const file = ledgerFile(dir, ticket);
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, ticket, captures: [] };
    throw error;
  }
  if (!stat.isFile()) throw invalid("ledger");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  if (!ledger || ledger.version !== 1 || ledger.ticket !== ticket || !Array.isArray(ledger.captures)) throw invalid("ledger");
  return ledger;
}

function writeLedger(dir, ledger) {
  const file = ledgerFile(dir, ledger.ticket);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `change` on the ticket's ledger under a short per-ticket lock and saves what it returns. */
function withLedger(dir, ticket, change) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, `${ticket}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = NaN;
      let age = 0;
      try {
        holder = Number(readFileSync(path.join(lock, "pid"), "utf8").trim());
        age = Date.now() - lstatSync(lock).mtimeMs;
      } catch { /* the holder is between mkdir and its pid write */ }
      if ((Number.isSafeInteger(holder) && !processAlive(holder)) || age > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw invalid(`ledger lock ${lock}`);
      sleep(100);
    }
  }
  try {
    const ledger = readLedger(dir, ticket);
    const result = change(ledger);
    writeLedger(dir, ledger);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Every entry the ticket has in `dirs`, each id once (the first ledger's copy wins). */
function unionLedger(dirs, ticket) {
  const seen = new Map();
  for (const dir of dirs) for (const entry of readLedger(dir, ticket).captures) if (!seen.has(entry.id)) seen.set(entry.id, entry);
  return { version: 1, ticket, captures: [...seen.values()] };
}

/** Admits a capture and records it as running in `dir` and every mirror, or throws the first refusal. */
async function beginCapture({ spec, facts, dir, mirrors = [], owner = "", pid = process.ppid, rulings, now = new Date(), alive = processAlive }) {
  const found = spec.override ? await findOverride(spec.override, spec.ticket, rulings) : null;
  let admitted;
  const result = withLedger(dir, spec.ticket, (ledger) => {
    const seen = unionLedger([dir, ...mirrors], spec.ticket);
    const { refusals, shots, estimatedMinutes } = captureRefusals(spec, facts, seen, { alive, now });
    if (refusals.length && !found) throw refused(refusals[0].text);
    if (refusals.length) {
      const refusal = overrideRefusal(found, refusals, spec.ticket);
      if (refusal) throw refusal;
    }
    const override = refusals.length ? { rulings: path.basename(found.rulings), quote: found.quote, kinds: [...new Set(refusals.map((refusal) => refusal.kind))] } : null;
    const entry = {
      id: randomUUID(), sha: facts.sha, main: facts.main, pages: spec.pages, states: spec.states, shots,
      estimatedMinutes, owner, pid, startedAt: now.toISOString(), status: EntryStatus.Running,
      ...(override ? { override } : {}),
    };
    ledger.captures.push(entry);
    admitted = entry;
    return { id: entry.id, ticket: spec.ticket, sha: facts.sha, main: facts.main, shots, estimatedMinutes, ledger: ledgerFile(dir, spec.ticket) };
  });
  for (const mirror of mirrors) withLedger(mirror, spec.ticket, (ledger) => { ledger.captures.push({ ...admitted }); });
  return result;
}

/** Marks a running entry ok (exit 0) or failed in `dir` and every mirror that holds it; a finished entry is never rewritten. */
function endCapture({ dir, mirrors = [], ticket, id, status, seconds, now = new Date() }) {
  const holders = [dir, ...mirrors].filter((candidate) => readLedger(candidate, ticket).captures.some((entry) => entry.id === id));
  if (holders.length === 0) throw invalid("id");
  let result;
  for (const holder of holders) {
    result = withLedger(holder, ticket, (ledger) => {
      const entry = ledger.captures.find((candidate) => candidate.id === id);
      if (entry.status !== EntryStatus.Running) throw invalid("id");
      entry.status = status === 0 ? EntryStatus.Ok : EntryStatus.Failed;
      entry.endedAt = now.toISOString();
      if (seconds !== undefined) entry.seconds = seconds;
      return { id, ticket, status: entry.status };
    });
  }
  return result;
}

/** The ticket's main baseline, finished captures, their shots and the measured rate, across `dir` and its mirrors. */
function captureStatus(dir, ticket, mirrors = [], alive = processAlive) {
  const ledger = unionLedger([dir, ...mirrors], ticket);
  const ok = ledger.captures.filter((entry) => entry.status === EntryStatus.Ok);
  const now = new Date();
  const baseline = countedEntries(ledger, alive, now).find((entry) => entry.main);
  return {
    ticket, ledger: ledgerFile(dir, ticket),
    mainBaseline: baseline ? { sha: baseline.sha, startedAt: baseline.startedAt, status: baseline.status } : null,
    captures: ok.length, shots: ok.reduce((sum, entry) => sum + entry.shots, 0),
    running: ledger.captures.filter((entry) => stillRunning(entry, alive, now)).length,
    secondsPerShot: measuredSecondsPerShot(ledger),
  };
}

function wholeNumber(text, field) {
  if (text === undefined || !/^\d+$/.test(text)) throw invalid(field);
  return Number(text);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, strict: true, options: {
    repo: { type: "string" }, ref: { type: "string" }, spec: { type: "string" }, facts: { type: "string" },
    ledger: { type: "string" }, owner: { type: "string" }, pid: { type: "string" }, ticket: { type: "string" }, rulings: { type: "string" },
    id: { type: "string" }, status: { type: "string" }, seconds: { type: "string" },
  } });
  const cloneRepo = () => values.repo ?? (values.ledger ? undefined : process.cwd());
  const dirFor = async () => {
    if (values.ledger) return path.resolve(values.ledger);
    const repo = cloneRepo();
    const fleet = await fleetLedgerFor(repo);
    try {
      return fleet ?? defaultLedgerDir(repo);
    } catch {
      throw invalid("ledger");
    }
  };
  const mirrorsFor = async () => {
    const repo = cloneRepo();
    if (!repo) return [];
    let mirror;
    try {
      mirror = defaultLedgerDir(repo);
    } catch {
      return [];
    }
    return path.resolve(mirror) === path.resolve(await dirFor()) ? [] : [mirror];
  };
  if (command === "facts") {
    if (!values.repo || !values.ref) throw invalid("arguments");
    return captureFacts(values.repo, values.ref);
  }
  if (command === "begin") {
    if (!values.spec || (values.repo === undefined) === (values.facts === undefined)) throw invalid("arguments");
    let specText;
    try {
      specText = readFileSync(values.spec, "utf8");
    } catch {
      throw invalid("spec");
    }
    const spec = parseSpec(specText);
    const facts = values.facts !== undefined ? parseFacts(values.facts) : captureFacts(values.repo, spec.ref);
    const pid = values.pid === undefined ? process.ppid : wholeNumber(values.pid, "pid");
    return beginCapture({ spec, facts, dir: await dirFor(), mirrors: await mirrorsFor(), owner: values.owner ?? "", pid, rulings: values.rulings });
  }
  if (command === "end") {
    if (!values.ticket || !values.id) throw invalid("arguments");
    const seconds = values.seconds === undefined ? undefined : wholeNumber(values.seconds, "seconds");
    return endCapture({ dir: await dirFor(), mirrors: await mirrorsFor(), ticket: values.ticket, id: values.id, status: wholeNumber(values.status, "status"), seconds });
  }
  if (command === "status") {
    if (!values.ticket) throw invalid("arguments");
    return captureStatus(await dirFor(), values.ticket, await mirrorsFor());
  }
  throw invalid("command");
}

function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CaptureRefusal ? REFUSED_EXIT : USAGE_EXIT;
  }
}
