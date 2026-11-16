import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./capture-guard.mjs", import.meta.url));
const TIMEOUT = { timeout: 30_000 };
const ENDING = "An operator ruling recorded for ISS-1 overrides this through the spec's override.";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A capture worktree cloned from a bare origin whose main holds one commit, plus a ledger directory. */
function repository({ withOrigin = true, branch = "main" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "capture-guard-")));
  const worktree = join(root, "wt");
  const commit = (message) => {
    const file = `${message.replaceAll(" ", "-")}.txt`;
    writeFileSync(join(worktree, file), `${message}\n`);
    git(worktree, "add", file);
    git(worktree, "-c", "user.name=t", "-c", "user.email=fixture.invalid", "commit", "-q", "-m", message);
    return git(worktree, "rev-parse", "HEAD");
  };
  if (withOrigin) {
    git(root, "init", "-q", "--bare", "-b", branch, "origin.git");
    git(root, "clone", "-q", join(root, "origin.git"), "wt");
  } else {
    git(root, "init", "-q", "-b", branch, "wt");
  }
  const first = commit("main one");
  if (withOrigin) git(worktree, "push", "-q", "origin", branch);
  if (withOrigin && branch !== "main") git(worktree, "remote", "set-head", "origin", "-a");
  const pushMain = (message) => {
    const sha = commit(message);
    git(worktree, "push", "-q", "origin", branch);
    return sha;
  };
  return { root, worktree, ledger: join(root, "ledger"), first, commit, pushMain };
}

function spec(r, fields) {
  const file = join(r.root, `spec-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ ticket: "ISS-1", pages: 2, states: 2, ...fields }));
  return file;
}

function guard(...args) {
  return spawnSync(process.execPath, [GUARD, ...args], { encoding: "utf8" });
}

function begin(r, fields, extra = []) {
  return guard("begin", "--spec", spec(r, fields), "--repo", r.worktree, "--ledger", r.ledger, ...extra);
}

/** Begins and ends one capture with the given exit status; returns the begin result. */
function capture(r, fields, { status = 0, seconds } = {}) {
  const started = begin(r, fields);
  assert.equal(started.status, 0, started.stderr);
  const { id } = JSON.parse(started.stdout);
  const ended = guard("end", "--ledger", r.ledger, "--ticket", "ISS-1", "--id", id, "--status", String(status),
    ...(seconds === undefined ? [] : ["--seconds", String(seconds)]));
  assert.equal(ended.status, 0, ended.stderr);
  return JSON.parse(started.stdout);
}

function ledger(r) {
  return JSON.parse(readFileSync(join(r.ledger, "ISS-1.json"), "utf8"));
}

function deadPid() {
  return spawnSync("true").pid;
}

test("AC-3 refuses a main commit already captured for the ticket", TIMEOUT, () => {
  const r = repository();
  const first = capture(r, { ref: "origin/main" });
  assert.equal(first.main, true);
  assert.equal(first.sha, r.first);
  const again = begin(r, { ref: r.first });
  assert.equal(again.status, 79);
  assert.equal(again.stderr, `capture-guard: refused: ${r.first} is a main commit already captured for ISS-1; reuse that baseline. ${ENDING}\n`);
  assert.equal(ledger(r).captures.length, 1, "a refused capture records nothing");
});

test("AC-2 refuses a second main baseline after main moved, and admits the branch that merged it", TIMEOUT, () => {
  const r = repository();
  capture(r, { ref: "origin/main" });
  const newer = r.pushMain("main two");
  const rebaseline = begin(r, { ref: newer });
  assert.equal(rebaseline.status, 79);
  assert.equal(rebaseline.stderr, `capture-guard: refused: ISS-1 already has its main baseline at ${r.first}; one main baseline per ticket, never retaken because main moved. ${ENDING}\n`);
  git(r.worktree, "checkout", "-q", "-b", "feature", r.first);
  r.commit("branch work");
  git(r.worktree, "-c", "user.name=t", "-c", "user.email=fixture.invalid", "merge", "-q", "--no-edit", "origin/main");
  const branch = begin(r, { ref: "HEAD" });
  assert.equal(branch.status, 0, branch.stderr);
  assert.equal(JSON.parse(branch.stdout).main, false);
});

test("AC-4 refuses more than 240 shots and admits 240", TIMEOUT, () => {
  const r = repository();
  git(r.worktree, "checkout", "-q", "-b", "feature");
  const branchSha = r.commit("branch work");
  const over = begin(r, { ref: branchSha, pages: 25, states: 10 });
  assert.equal(over.status, 79);
  assert.equal(over.stderr, `capture-guard: refused: 25 pages x 10 states is 250 shots, over the 240 shot budget for one capture; capture only the states the change can reach. ${ENDING}\n`);
  const within = begin(r, { ref: branchSha, pages: 24, states: 10 });
  assert.equal(within.status, 0, within.stderr);
  assert.equal(JSON.parse(within.stdout).shots, 240);
});

test("AC-4 refuses a capture over 20 minutes at the ticket's slowest measured seconds per shot, not its latest or mean", TIMEOUT, () => {
  const r = repository();
  git(r.worktree, "checkout", "-q", "-b", "feature");
  const branchSha = r.commit("branch work");
  capture(r, { ref: branchSha, pages: 10, states: 10 }, { seconds: 1000 });
  capture(r, { ref: branchSha, pages: 10, states: 10 }, { seconds: 600 });
  const slow = begin(r, { ref: branchSha, pages: 13, states: 10 });
  assert.equal(slow.status, 79);
  assert.equal(slow.stderr, `capture-guard: refused: 130 shots at 10 s each is about 22 minutes, over the 20 minute budget for one capture; capture only the states the change can reach. ${ENDING}\n`);
  const fits = begin(r, { ref: branchSha, pages: 12, states: 10 });
  assert.equal(fits.status, 0, fits.stderr);
  assert.equal(JSON.parse(fits.stdout).estimatedMinutes, 20);
});

/** A ticket with a main baseline, and a rulings file holding `lines`; `override(quote)` tries a repeat baseline. */
function overrideFixture(lines) {
  const r = repository();
  capture(r, { ref: "origin/main" });
  const rulings = join(r.root, "rulings.md");
  writeFileSync(rulings, `${lines.join("\n")}\n`);
  const override = (quote, fields = {}, extra = ["--rulings", rulings]) => begin(r, { ref: r.first, override: { quote }, ...fields }, extra);
  const noLine = `capture-guard: refused: ${rulings} has no Ruling line naming ISS-1 with those quoted words; only an operator ruling recorded for this ticket overrides a refusal.\n`;
  const noMarker = (kind) => `capture-guard: refused: ${rulings} has a Ruling line for ISS-1 with those quoted words, but it does not carry \`capture-guard override: ${kind}\` for this refusal.\n`;
  const add = (line) => writeFileSync(rulings, `${readFileSync(rulings, "utf8")}${line}\n`);
  return { r, rulings, override, noLine, noMarker, add };
}

test("AC-3 AC-4 override (a): the marked Ruling line names the ticket by its exact slug", TIMEOUT, () => {
  const o = overrideFixture([
    "- Ruling 2026-11-13 (operator): \"retake the baseline\" ISS-2 capture-guard override: baseline",
    "- Ruling 2026-11-13 (operator): \"retake the baseline\" ISS-12 capture-guard override: baseline",
    "- Ruling 2026-11-13 (operator): \"retake the baseline\" ISS-10 capture-guard override: baseline",
  ]);
  const other = o.override("retake the baseline");
  assert.equal(other.status, 79, "another ticket, a prefix or a suffix of the slug");
  assert.equal(other.stderr, o.noLine);
  o.add("- Ruling 2026-11-13 (operator): \"retake the baseline\" ISS-1");
  const unmarked = o.override("retake the baseline");
  assert.equal(unmarked.status, 79, "markers on other tickets' lines do not count for this ticket");
  assert.equal(unmarked.stderr, o.noMarker("baseline"));
  o.add("- Ruling 2026-11-13 (operator): \"retake the baseline\" ISS-1 capture-guard override: baseline");
  assert.equal(o.override("retake the baseline").status, 0, "the exact slug");
});

test("AC-3 AC-4 override (e): the ticket and the marker count only outside quoted words", TIMEOUT, () => {
  const o = overrideFixture([
    "- Ruling 2026-11-14 (operator): \"no, do not add capture-guard override: budget\" ISS-1",
    "- Ruling (operator, 2026-11-14, ISS-1): \"keep it\" and \"capture-guard override: baseline\"",
    "- Ruling 2026-11-14 (operator): \"ISS-1 retake it\" capture-guard override: baseline",
  ]);
  const markerInQuote = o.override("no, do not add capture-guard override: budget");
  assert.equal(markerInQuote.status, 79);
  assert.equal(markerInQuote.stderr, o.noMarker("baseline"), "a marker inside the quoted words");
  const markerInOtherSpan = o.override("keep it");
  assert.equal(markerInOtherSpan.status, 79);
  assert.equal(markerInOtherSpan.stderr, o.noLine, "a marker in a second quoted span: the line has two spans");
  const quotedTicket = o.override("ISS-1 retake it");
  assert.equal(quotedTicket.status, 79, "the ticket named only inside quoted words");
  assert.equal(quotedTicket.stderr, o.noLine);
  o.add("- Ruling (operator, 2026-11-14, ISS-1): capture-guard override: baseline \"no, do not add \"capture-guard override: budget\" yet\"");
  o.add("- Ruling (operator, 2026-11-14): capture-guard override: baseline \"retake \"ISS-1\" baseline\"");
  const innerMarker = o.override("no, do not add \"capture-guard override: budget\" yet", { pages: 25, states: 10 });
  assert.equal(innerMarker.status, 79, "operator words that contain double quotes never match");
  assert.equal(innerMarker.stderr, o.noLine);
  const innerTicket = o.override("retake \"ISS-1\" baseline");
  assert.equal(innerTicket.status, 79, "the ticket inside double quotes within the operator's words");
  assert.equal(innerTicket.stderr, o.noLine);
  o.add("- Ruling (operator, 2026-11-14, ISS-1): capture-guard override: baseline \"keep going\", \"one more\", \"do not use capture-guard override: budget\"");
  o.add("- Ruling (operator, 2026-11-14, ISS-2): capture-guard override: baseline \"keep\", \"once\", \"for ISS-1\"");
  const fromClosing = o.override(", \"one more", { pages: 25, states: 10 });
  assert.equal(fromClosing.status, 79, "a spec quote that starts at a closing quote");
  assert.equal(fromClosing.stderr, o.noLine);
  const otherTicket = o.override(", \"once");
  assert.equal(otherTicket.status, 79, "a spec quote that flips the pairing onto another ticket's line");
  assert.equal(otherTicket.stderr, o.noLine);
});

test("AC-3 AC-4 override (f): the spec's quote must be one whole quoted span of a line whose quotes pair cleanly", TIMEOUT, () => {
  const o = overrideFixture([
    "- Ruling (operator, 2026-11-14, ISS-1): capture-guard override: baseline \"keep going\" (\"do not use capture-guard override: budget\")",
    "- Ruling (operator, 2026-11-14, ISS-2): capture-guard override: baseline \"keep going\", \"for ISS-1\"",
    "- Ruling (operator, 2026-11-14, ISS-1): capture-guard override: baseline \"skip:\"capture-guard override: budget\" for now\"",
    "- Ruling (operator, 2026-11-14): capture-guard override: baseline \"retake for:\"ISS-1\" later\"",
    "- Ruling (operator, 2026-11-14, ISS-1): capture-guard override: baseline \"stray\" and a lone \" here",
    "- Ruling 2026-11-14 (operator): \"retake the whole baseline\" ISS-1 capture-guard override: baseline",
  ]);
  const big = { pages: 25, states: 10 };
  for (const [quote, fields, why] of [
    ["keep going\" (", big, "a quote that runs into the next span"],
    ["keep going\",", {}, "a quote that runs into another ticket's span"],
    ["skip:", big, "a prefix of operator words that contain double quotes"],
    ["retake for:", {}, "a prefix that would expose a quoted ticket"],
    ["stray", {}, "a line with an odd number of double quotes"],
    ["retake the", {}, "a substring of a whole span"],
  ]) {
    const result = o.override(quote, fields);
    assert.equal(result.status, 79, why);
    assert.equal(result.stderr, o.noLine, why);
  }
  const whole = o.override("retake the whole baseline");
  assert.equal(whole.status, 0, `the whole span is honest words: ${whole.stderr}`);
});

test("AC-3 AC-4 override (b): each marker lifts only its own kind of refusal, and both lift both", TIMEOUT, () => {
  const o = overrideFixture([
    "- Ruling 2026-11-14 (operator): \"baseline only\" ISS-1 capture-guard override: baseline",
    "- Ruling 2026-11-14 (operator): \"budget only\" ISS-1 capture-guard override: budget",
    "- Ruling 2026-11-14 (operator): \"both\" ISS-1 capture-guard override: baseline, capture-guard override: budget",
    "- Ruling 2026-11-14 (operator): \"split\" ISS-1 capture-guard override: baseline",
    "- Ruling 2026-11-14 (operator): \"split\" ISS-1 capture-guard override: budget",
  ]);
  const big = { pages: 25, states: 10 };
  const baselineOnBoth = o.override("baseline only", big);
  assert.equal(baselineOnBoth.status, 79, "a baseline marker does not lift the shot budget");
  assert.equal(baselineOnBoth.stderr, o.noMarker("budget"));
  const budgetOnRepeat = o.override("budget only");
  assert.equal(budgetOnRepeat.status, 79, "a budget marker does not lift a repeat main baseline");
  assert.equal(budgetOnRepeat.stderr, o.noMarker("baseline"));
  assert.equal(o.override("baseline only").status, 0, "a baseline marker lifts a repeat main baseline");
  git(o.r.worktree, "checkout", "-q", "-b", "feature");
  const branchSha = o.r.commit("branch work");
  assert.equal(o.override("budget only", { ref: branchSha, ...big }).status, 0, "a budget marker lifts the shot budget");
  const both = o.override("both", big);
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual(ledger(o.r).captures.at(-1).override, { rulings: "rulings.md", quote: "both", kinds: ["baseline", "budget"] });
  assert.equal(o.override("split", big).status, 0, "the two markers may sit on two lines with the same quoted words");
});

test("AC-3 AC-4 override (c): a marker needs the spec's quoted words verbatim, on a Ruling line, in the file begin is given", TIMEOUT, () => {
  const o = overrideFixture([
    "- Ruling 2026-11-13 (operator): \"other words\" ISS-1 capture-guard override: baseline",
    "- Ruling (operator, 2026-11-13, ISS-1): capture-guard override: baseline retake the baseline",
    "- Note: Ruling (operator, ISS-1): capture-guard override: baseline \"retake the baseline\"",
    "- Ruling 2026-11-13 (operator): \"keep going\" ISS-1",
  ]);
  const noQuote = o.override("retake the baseline");
  assert.equal(noQuote.status, 79, "a marker without the quoted words, unquoted words, or a line that is not a Ruling record");
  assert.equal(noQuote.stderr, o.noLine);
  const unmarked = o.override("keep going");
  assert.equal(unmarked.status, 79, "the quoted words without the marker");
  assert.equal(unmarked.stderr, o.noMarker("baseline"));
  assert.equal(o.override("retake the baseline", { override: { rulings: o.rulings, quote: "retake the baseline" } }).status, 2,
    "the spec cannot name its own rulings file");
  o.add("- Ruling 2026-11-13 (operator): \"retake the baseline\" ISS-1 capture-guard override: baseline");
  const partial = o.override("retake the");
  assert.equal(partial.status, 79, "a partial quote of a valid ruling");
  assert.equal(partial.stderr, o.noLine);
  assert.equal(o.override("retake the baseline", {}, []).status, 79, "no rulings file given");
  const allowed = o.override("retake the baseline");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(ledger(o.r).captures.at(-1).override, { rulings: "rulings.md", quote: "retake the baseline", kinds: ["baseline"] });
});

test("AC-2 AC-3 a running entry holds its place until end or its time bound, even after its caller exits", TIMEOUT, () => {
  const r = repository();
  capture(r, { ref: "origin/main" }, { status: 1 });
  const exited = begin(r, { ref: "origin/main" }, ["--pid", String(deadPid())]);
  assert.equal(exited.status, 0, exited.stderr);
  const blocked = begin(r, { ref: "origin/main" });
  assert.equal(blocked.status, 79, "a direct baseline whose shell exited still counts");
  assert.match(blocked.stderr, /is a main commit already captured for ISS-1/);
  const status = JSON.parse(guard("status", "--ticket", "ISS-1", "--ledger", r.ledger).stdout);
  assert.equal(status.mainBaseline.sha, r.first);
  assert.equal(status.running, 1);
  const early = ledger(r);
  early.captures[1].startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  writeFileSync(join(r.ledger, "ISS-1.json"), JSON.stringify(early));
  assert.equal(begin(r, { ref: "origin/main" }).status, 79, "5 minutes in, under the 20 minute floor, the place still holds");
  const aged = ledger(r);
  aged.captures[1].startedAt = new Date(Date.now() - 21 * 60_000).toISOString();
  writeFileSync(join(r.ledger, "ISS-1.json"), JSON.stringify(aged));
  const retry = begin(r, { ref: "origin/main" }, ["--pid", String(process.pid)]);
  assert.equal(retry.status, 0, "past the 20 minute bound with a dead owner the place is free");
  const live = ledger(r);
  live.captures[2].startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  writeFileSync(join(r.ledger, "ISS-1.json"), JSON.stringify(live));
  assert.equal(begin(r, { ref: "origin/main" }).status, 79, "a live owner holds its place past the bound");
  assert.deepEqual(ledger(r).captures.map((entry) => entry.status), ["failed", "running", "running"]);
});

test("end records a running entry once and refuses to rewrite a finished one", TIMEOUT, () => {
  const r = repository();
  const baseline = capture(r, { ref: "origin/main" }, { seconds: 40 });
  for (const extra of [["--status", "1"], ["--status", "0", "--seconds", "0"]]) {
    const rewrite = guard("end", "--ledger", r.ledger, "--ticket", "ISS-1", "--id", baseline.id, ...extra);
    assert.equal(rewrite.status, 2, extra.join(" "));
  }
  assert.deepEqual(ledger(r).captures.map((entry) => [entry.status, entry.seconds]), [["ok", 40]]);
  assert.equal(begin(r, { ref: "origin/main" }).status, 79, "the baseline still counts");
});

test("a main commit is an ancestor of the origin default branch, whatever it is named", TIMEOUT, () => {
  const r = repository({ branch: "trunk" });
  assert.equal(git(r.worktree, "symbolic-ref", "refs/remotes/origin/HEAD"), "refs/remotes/origin/trunk");
  const tip = guard("facts", "--repo", r.worktree, "--ref", "origin/trunk");
  assert.equal(tip.status, 0, tip.stderr);
  assert.equal(JSON.parse(tip.stdout).main, true);
  git(r.worktree, "checkout", "-q", "-b", "feature");
  const branchSha = r.commit("branch work");
  const branch = guard("facts", "--repo", r.worktree, "--ref", branchSha);
  assert.equal(branch.status, 0, branch.stderr);
  assert.equal(JSON.parse(branch.stdout).main, false);
});

test("refuses when the capture worktree has no origin default branch", TIMEOUT, () => {
  const r = repository({ withOrigin: false });
  const result = begin(r, { ref: "HEAD" });
  assert.equal(result.status, 79);
  assert.equal(result.stderr, `capture-guard: refused: cannot tell whether HEAD is a main commit in ${r.worktree}: no origin default branch.\n`);
  assert.equal(existsSync(join(r.ledger, "ISS-1.json")), false);
});

test("facts read on the capture host feed begin without a local worktree", TIMEOUT, () => {
  const r = repository();
  const facts = guard("facts", "--repo", r.worktree, "--ref", "origin/main");
  assert.equal(facts.status, 0, facts.stderr);
  assert.equal(JSON.parse(facts.stdout).main, true);
  const first = guard("begin", "--spec", spec(r, { ref: "origin/main" }), "--facts", facts.stdout.trim(), "--ledger", r.ledger);
  assert.equal(first.status, 0, first.stderr);
  const second = guard("begin", "--spec", spec(r, { ref: "origin/main" }), "--facts", facts.stdout.trim(), "--ledger", r.ledger);
  assert.equal(second.status, 79);
});

test("a bad spec is a usage error that records nothing", TIMEOUT, () => {
  const r = repository();
  for (const fields of [{ ref: "origin/main", pages: 0 }, { ref: "origin/main", ticket: "iss-1" }, { ref: "origin/main", extra: 1 }]) {
    const result = begin(r, fields);
    assert.equal(result.status, 2, JSON.stringify(fields));
  }
  assert.equal(existsSync(join(r.ledger, "ISS-1.json")), false);
});

test("AC-2 AC-3 a clone's own ledger and a fleet ledger mirror each other, and the clone's is the default", TIMEOUT, () => {
  const r = repository();
  const direct = spawnSync(process.execPath, [GUARD, "begin", "--spec", spec(r, { ref: "origin/main" }), "--repo", r.worktree],
    { cwd: r.worktree, encoding: "utf8" });
  assert.equal(direct.status, 0, direct.stderr);
  const fleetLedger = join(r.root, "orch-captures");
  const fromFleet = guard("begin", "--spec", spec(r, { ref: "origin/main" }), "--repo", r.worktree, "--ledger", fleetLedger);
  assert.equal(fromFleet.status, 79, "the fleet sees the clone's baseline");
  const r2 = repository();
  const fleetLedger2 = join(r2.root, "orch-captures");
  const fleetFirst = guard("begin", "--spec", spec(r2, { ref: "origin/main" }), "--repo", r2.worktree, "--ledger", fleetLedger2);
  assert.equal(fleetFirst.status, 0, fleetFirst.stderr);
  const directAfter = spawnSync(process.execPath, [GUARD, "begin", "--spec", spec(r2, { ref: "origin/main" }), "--repo", r2.worktree],
    { cwd: r2.worktree, encoding: "utf8" });
  assert.equal(directAfter.status, 79, "the clone sees the fleet's baseline");
  const status = spawnSync(process.execPath, [GUARD, "status", "--ticket", "ISS-1"], { cwd: r2.worktree, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).mainBaseline.sha, r2.first, "status with no flags reads the current clone's ledger");
  const { id } = JSON.parse(fleetFirst.stdout);
  const ended = guard("end", "--ticket", "ISS-1", "--id", id, "--status", "0", "--ledger", fleetLedger2, "--repo", r2.worktree);
  assert.equal(ended.status, 0, ended.stderr);
  const clone = JSON.parse(readFileSync(join(r2.worktree, ".git", "vibe-captures", "ISS-1.json"), "utf8"));
  assert.equal(clone.captures[0].status, "ok", "end updates the mirror too");
});

/** A repository whose ticket `ticket` has a main baseline; `again(quote, rulings)` tries a repeat baseline with that override. */
function baselineFor(ticket) {
  const r = repository();
  const first = guard("begin", "--spec", spec(r, { ticket, ref: "origin/main" }), "--repo", r.worktree, "--ledger", r.ledger);
  assert.equal(first.status, 0, first.stderr);
  const again = (quote, rulings) => guard("begin", "--spec", spec(r, { ticket, ref: "origin/main", override: { quote } }),
    "--repo", r.worktree, "--ledger", r.ledger, "--rulings", rulings);
  return { r, again };
}

test("AC-3 AC-4 override (d): program rulings that quote the operator but carry no marker lift nothing", TIMEOUT, () => {
  // Four program rulings recorded on 2026-11-13 (rulings.md lines 72, 76, 98 and 101), copied as literal lines with the person named as the operator.
  const screenshots = "- Ruling (operator, 2026-11-13 ~22:05Z, relayed by the flamingo fleet orchestrator, ISS-14158): \"we can't keep running a full screenshot of main just because we merge main in. that's crazy. let's just have a single visual-qa agent look at our branch and check to make sure it's doing everything it should be doing and looks good... no more 2+ hour screenshotting\"; \"we've already ran the screenshots and fixed all the bugs so now we just need an isolated analysis on our changes only\". Codify so it never recurs.";
  const evals = "- Ruling (operator, chat 2026-11-13 ~15:00Z, PR #426 evals): \"then maybe running it here isn't smart\"; \"move it to 2nd laptop\". Applied: eval worker moves to laptop 2, one Codex case at a time, light slot, pausing on that machine's load; ISS-13164's captures keep precedence.";
  const holdLifted = "- Ruling (operator, 2026-11-13 ~15:40Z, relayed by the flamingo fleet orchestrator): ISS-13164 is the priority on the primary laptop; other heavy runs there wait for its full lane pass. Hold lifted ~19:56Z by flamingo (\"no further hold from me on the primary laptop\"); in force: nothing of this program on laptop 2's heavy or e2e slots until flamingo says ISS-13164's captures are done (light eval cases allowed).";
  const criterion = "- Ruling (operator, ~22:25Z 2026-11-13, \"yes that's fine\", relayed by flamingo, ISS-14158 criterion 1 text): default = one visual-qa reviewer on diff + stories; capture only for (a) shared component pixels across pages (once, one main baseline at start), (b) criteria/ruling asks for visual proof, (c) reviewer cannot settle a finding (targeted shots); one main baseline per ticket never retaken; recapture only states a fix reaches; final check = one visual-qa pass on changes since last reviewed capture.";
  const a = baselineFor("ISS-14158");
  const aRulings = join(a.r.root, "rulings.md");
  writeFileSync(aRulings, `${screenshots}\n${criterion}\n`);
  const fromScreenshots = a.again("we've already ran the screenshots and fixed all the bugs so now we just need an isolated analysis on our changes only", aRulings);
  assert.equal(fromScreenshots.status, 79);
  assert.match(fromScreenshots.stderr, /has no Ruling line naming ISS-14158/, "two quoted spans: the line counts for nothing");
  const fromCriterion = a.again("yes that's fine", aRulings);
  assert.equal(fromCriterion.status, 79);
  assert.match(fromCriterion.stderr, /has no Ruling line naming ISS-14158/, "not the fixed shape: the decision does not begin with the quote");
  const b = baselineFor("ISS-13164");
  const bRulings = join(b.r.root, "rulings.md");
  writeFileSync(bRulings, `${evals}\n${holdLifted}\n`);
  for (const quote of ["move it to 2nd laptop", "no further hold from me on the primary laptop"]) {
    assert.equal(b.again(quote, bRulings).status, 79, quote);
  }
  writeFileSync(bRulings, `${evals}\n- Ruling 2026-11-14 (operator): "retake it" ISS-13164 capture-guard override: baseline\n`);
  const retaken = b.again("retake it", bRulings);
  assert.equal(retaken.status, 0, retaken.stderr);
});

test("AC-2 AC-3 inside a fleet program the default ledger is the program's, else the clone's", TIMEOUT, () => {
  const r = repository();
  const home = join(r.root, "home");
  const program = join(r.root, "fleet", "programs", "p1");
  mkdirSync(join(home, ".vibe-hook-scope", "fleet-binding"), { recursive: true });
  mkdirSync(program, { recursive: true });
  writeFileSync(join(program, "board.json"), JSON.stringify({ writers: { w1: { worktree: r.worktree } } }));
  const env = { ...process.env, HOME: home };
  delete env.FLEET_HOME;
  const direct = (args, extra = {}) => spawnSync(process.execPath, [GUARD, ...args], { cwd: r.worktree, encoding: "utf8", env: { ...env, ...extra } });
  const cloneOnly = direct(["begin", "--spec", spec(r, { ref: "origin/main" }), "--repo", r.worktree]);
  assert.equal(cloneOnly.status, 0, cloneOnly.stderr);
  assert.equal(JSON.parse(cloneOnly.stdout).ledger, join(r.worktree, ".git", "vibe-captures", "ISS-1.json"), "no binding: the clone's ledger");
  assert.equal(existsSync(join(program, "captures")), false);
  writeFileSync(join(home, ".vibe-hook-scope", "fleet-binding", "chat-1.json"),
    JSON.stringify({ chat: "chat-1", home: join(r.root, "fleet"), program: "p1" }));
  const r2 = repository();
  writeFileSync(join(program, "board.json"), JSON.stringify({ writers: { w1: { worktree: r.worktree }, w2: { worktree: r2.worktree } } }));
  const inFleet = spawnSync(process.execPath, [GUARD, "begin", "--spec", spec(r2, { ref: "origin/main" }), "--repo", r2.worktree],
    { cwd: r2.worktree, encoding: "utf8", env });
  assert.equal(inFleet.status, 0, inFleet.stderr);
  assert.equal(JSON.parse(inFleet.stdout).ledger, join(program, "captures", "ISS-1.json"), "a bound program's board lists this worktree");
  const status = spawnSync(process.execPath, [GUARD, "status", "--ticket", "ISS-1"], { cwd: r2.worktree, encoding: "utf8", env });
  assert.equal(JSON.parse(status.stdout).ledger, join(program, "captures", "ISS-1.json"), "status with no flags reads the program ledger");
  const viaFleetHome = direct(["status", "--ticket", "ISS-1"], { HOME: join(r.root, "nohome"), FLEET_HOME: join(r.root, "fleet") });
  assert.equal(JSON.parse(viaFleetHome.stdout).ledger, join(program, "captures", "ISS-1.json"), "FLEET_HOME finds the program too");
  const r3 = repository();
  const clone3 = join(r3.worktree, ".git", "vibe-captures", "ISS-1.json");
  const in3 = (args, extra = {}) => spawnSync(process.execPath, [GUARD, ...args], { cwd: r3.worktree, encoding: "utf8", env: { ...env, ...extra } });
  const otherOnly = in3(["begin", "--spec", spec(r3, { ref: "origin/main" }), "--repo", r3.worktree]);
  assert.equal(otherOnly.status, 0, otherOnly.stderr);
  assert.equal(JSON.parse(otherOnly.stdout).ledger, clone3, "a bound program whose board lists only other worktrees");
  assert.equal(JSON.parse(in3(["status", "--ticket", "ISS-1"]).stdout).ledger, clone3);
  const second = join(r.root, "fleet2", "programs", "p2");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "board.json"), JSON.stringify({ writers: { w3: { worktree: r3.worktree } } }));
  writeFileSync(join(program, "board.json"), JSON.stringify({ writers: { w1: { worktree: r.worktree }, w2: { worktree: r2.worktree }, w3: { worktree: r3.worktree } } }));
  const twoPrograms = in3(["status", "--ticket", "ISS-1"], { FLEET_HOME: join(r.root, "fleet2") });
  assert.equal(JSON.parse(twoPrograms.stdout).ledger, clone3, "two programs list this worktree: the clone's ledger");
  const linked = join(r.root, "fleet-link");
  symlinkSync(join(r.root, "fleet"), linked);
  const sameHome = direct(["status", "--ticket", "ISS-1"], { FLEET_HOME: linked });
  assert.equal(JSON.parse(sameHome.stdout).ledger, join(realpathSync(program), "captures", "ISS-1.json"),
    "a symlinked FLEET_HOME and a binding naming the same home are one program");
});

test("AC-3 AC-4 override (g): a Ruling line counts only with exactly one ASCII quoted span and no curly quotes", TIMEOUT, () => {
  const o = overrideFixture([
    "- Ruling (operator, 2026-11-14, ISS-1): capture-guard override: baseline \"keep going \" ISS-1 capture-guard override: budget \" later\"",
    "- Ruling (operator, 2026-11-14, ISS-1): capture-guard override: baseline \"retake it\" “capture-guard override: budget”",
    "- Ruling (operator, 2026-11-14, ISS-1): capture-guard override: baseline \"go\" and \"now\"",
    "- Ruling 2026-11-14 (operator): \"one honest span\" ISS-1 capture-guard override: baseline",
  ]);
  const big = { pages: 25, states: 10 };
  for (const [quote, fields, why] of [
    ["keep going", big, "space-padded inner quotes in the operator's words"],
    ["retake it", big, "curly double quotes on the line"],
    ["go", {}, "two quoted spans"],
  ]) {
    const result = o.override(quote, fields);
    assert.equal(result.status, 79, why);
    assert.equal(result.stderr, o.noLine, why);
  }
  const honest = o.override("one honest span");
  assert.equal(honest.status, 0, honest.stderr);
});

test("AC-3 AC-4 override (h): only the fixed shape counts, with the quote first and the ticket and marker after it", TIMEOUT, () => {
  const o = overrideFixture([
    "- Ruling 2026-11-14 (operator): 'yes \"ok\" ISS-1 capture-guard override: budget' ISS-1 capture-guard override: baseline",
    "- Ruling 2026-11-14 (operator): «yes \"ok\" ISS-1 capture-guard override: budget» ISS-1 capture-guard override: baseline",
    "- Ruling 2026-11-14 (operator): „yes \"ok\" ISS-1 capture-guard override: budget‟ ISS-1 capture-guard override: baseline",
    "- Ruling 2026-11-14 (operator): ＂yes \"ok\" ISS-1 capture-guard override: budget＂ ISS-1 capture-guard override: baseline",
    "- Ruling 2026-11-14 (operator): capture-guard override: baseline \"retake it\" ISS-1",
    "- Ruling 2026-11-14 (operator, ISS-1): \"retake it again\" capture-guard override: baseline",
    "- Ruling 2026-11-14 (operator): \"retake the main baseline\" ISS-1 capture-guard override: baseline",
  ]);
  const wrapped = o.override("ok", { pages: 25, states: 10 });
  assert.equal(wrapped.status, 79, "operator words wrapped in other quote marks");
  assert.equal(wrapped.stderr, o.noLine);
  for (const [quote, why] of [["retake it", "a marker before the quoted span"], ["retake it again", "the ticket only before the quoted span"]]) {
    const result = o.override(quote);
    assert.equal(result.status, 79, why);
    assert.equal(result.stderr, o.noLine, why);
  }
  const honest = o.override("retake the main baseline");
  assert.equal(honest.status, 0, honest.stderr);
});

test("AC-3 AC-4 override (i): the decision follows the source parenthesis, whatever colons the source holds", TIMEOUT, () => {
  const o = overrideFixture([
    "- Ruling 2026-11-14 (operator message: chat): \"retake from chat\" ISS-1 capture-guard override: baseline",
    "- Ruling 2026-11-14 (ticket: ISS-1): \"retake from the ticket\" ISS-1 capture-guard override: baseline",
    "- Ruling (operator, chat 2026-11-14 ~07:10Z): \"retake at seven\" ISS-1 capture-guard override: baseline",
    "- Ruling 2026-11-14 (operator message: chat): later, \"retake after a word\" ISS-1 capture-guard override: baseline",
  ]);
  for (const quote of ["retake from chat", "retake from the ticket", "retake at seven"]) {
    const result = o.override(quote);
    assert.equal(result.status, 0, `${quote}: ${result.stderr}`);
  }
  const notFirst = o.override("retake after a word");
  assert.equal(notFirst.status, 79, "the quoted span does not directly follow the source parenthesis");
  assert.equal(notFirst.stderr, o.noLine);
});

test("AC-3 AC-4 override (j): lines split where the Ruling matcher splits them, so a pasted chunk never spans two", TIMEOUT, () => {
  const o = overrideFixture([]);
  for (const [separator, name] of [["\r", "CR"], ["\u2028", "U+2028"], ["\u2029", "U+2029"]]) {
    writeFileSync(o.rulings, `- Ruling 2026-11-14 approved: yes${separator}pasted note (x): "words" ISS-1 capture-guard override: baseline\n`);
    const result = o.override("words");
    assert.equal(result.status, 79, name);
    assert.equal(result.stderr, o.noLine, name);
  }
  writeFileSync(o.rulings, `- Ruling 2026-11-14 (operator): "saved with crlf" ISS-1 capture-guard override: baseline\r\n`);
  const crlf = o.override("saved with crlf");
  assert.equal(crlf.status, 0, `a CRLF rulings file grants an honest override: ${crlf.stderr}`);
});
