#!/usr/bin/env node
// The Spec Card checks (references/spec-card.md is the rule).
//
// Usage:
//   spec-card.mjs check <card.json> [--stage draft|locked] [--checkpoint]
//   spec-card.mjs save --worktree <path> --stage draft|locked <card.json>
//   spec-card.mjs path --worktree <path>
//   spec-card.mjs budget --card <card.json> --worktree <path> --base <sha>
//   spec-card.mjs assumptions <card.json> [--worktree <path> --base <sha>]
//   spec-card.mjs evidence-skeleton <card.json>
//
// check prints {ok, problems, wouldBlock, blocking, checkpoint, engineeringDecisions}; exits 1 on a problem,
//   and on an unanswered blocking question only when the fork checkpoint is switched on.
// budget prints the justification report and always exits 0 on a readable card: it never blocks.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const EVIDENCE_TYPES = ["test", "script", "screenshot", "api-read"];
export const ASSUMPTION_TAGS = ["grounded", "unverified"];
export const QUESTION_KINDS = ["assumption", "product-fork", "technical-fork"];
export const CHECKPOINT_ENV = "VIBE_FORK_CHECKPOINT";
export const CARD_FILE = "vibe-spec-card.json";

const CRITERION_ID = /^AC-\d+$/;
const SESSION_ARTIFACTS = /^\.closedloop-ai\//;

const isText = (value) => typeof value === "string" && value.trim() !== "";
const list = (value) => (Array.isArray(value) ? value : []);

/** Whether the fork checkpoint is switched on. Off unless the flag or VIBE_FORK_CHECKPOINT=1 says so. */
export function checkpointEnabled(flag, env = process.env) {
  return flag === true || env[CHECKPOINT_ENV] === "1";
}

/** Problems with the card's shape, the questions that would block code, and the engineering decisions. */
export function cardProblems(card, stage = "draft") {
  const problems = [];
  const wouldBlock = [];
  const engineeringDecisions = [];
  if (card?.version !== 1) problems.push("version must be 1");
  const criteria = list(card?.criteria);
  if (criteria.length === 0) problems.push("the card has no criteria");
  const criterionIds = new Set();
  for (const criterion of criteria) {
    if (!CRITERION_ID.test(String(criterion?.id))) problems.push(`criterion ${JSON.stringify(criterion?.id)}: id must look like AC-1`);
    else if (criterionIds.has(criterion.id)) problems.push(`${criterion.id}: duplicate id`);
    else criterionIds.add(criterion.id);
    if (!isText(criterion?.text) || !isText(criterion?.source)) problems.push(`${criterion?.id}: needs quoted text and a source`);
    if (!EVIDENCE_TYPES.includes(criterion?.evidence)) problems.push(`${criterion?.id}: evidence must be one of ${EVIDENCE_TYPES.join(", ")}`);
  }
  const assumptions = new Map();
  for (const assumption of list(card?.assumptions)) {
    assumptions.set(assumption?.id, assumption);
    problems.push(...assumptionProblems(assumption));
  }
  const questionedAssumptions = new Set();
  for (const question of list(card?.openQuestions)) {
    problems.push(...questionProblems(question, assumptions));
    if (question?.assumption) questionedAssumptions.add(question.assumption);
    if (question?.kind === "technical-fork") engineeringDecisions.push(question.id);
    else if (!isAnswered(question)) wouldBlock.push(question?.id);
  }
  for (const [id, assumption] of assumptions) {
    if (assumption?.tag === "unverified" && assumption.productImpacting === true && !questionedAssumptions.has(id)) {
      problems.push(`${id}: an unverified product-impacting assumption needs an open question with options and a recommendation`);
    }
  }
  if (stage === "locked") problems.push(...planProblems(card?.plan, criterionIds));
  return { problems, wouldBlock, engineeringDecisions };
}

function assumptionProblems(assumption) {
  const id = assumption?.id;
  if (!isText(id)) return ["an assumption has no id"];
  const problems = [];
  if (!isText(assumption.text)) problems.push(`${id}: needs text`);
  if (!ASSUMPTION_TAGS.includes(assumption.tag)) problems.push(`${id}: tag must be grounded or unverified`);
  if (!isText(assumption.falsifiedBy)) problems.push(`${id}: name what would falsify it`);
  if (assumption.tag === "grounded" && !isText(assumption.basis)) problems.push(`${id}: a grounded assumption needs a basis`);
  if (assumption.tag === "unverified" && typeof assumption.productImpacting !== "boolean") {
    problems.push(`${id}: an unverified assumption needs productImpacting true or false`);
  }
  return problems;
}

function isAnswered(question) {
  return isText(question?.answer?.source) && isText(question?.answer?.text);
}

function questionProblems(question, assumptions) {
  const id = question?.id;
  if (!isText(id)) return ["an open question has no id"];
  const problems = [];
  if (!QUESTION_KINDS.includes(question.kind)) problems.push(`${id}: kind must be one of ${QUESTION_KINDS.join(", ")}`);
  if (!isText(question.question)) problems.push(`${id}: needs the decision it asks for`);
  const options = list(question.options);
  const labels = options.map((option) => option?.label);
  if (options.length < 2 || options.length > 3 || options.some((option) => !isText(option?.label) || !isText(option?.summary))) {
    problems.push(`${id}: needs 2 to 3 options, each with a label and an end-to-end summary`);
  }
  if (!labels.includes(question.recommendation)) problems.push(`${id}: recommendation must name one of the options`);
  if (question.kind === "assumption") {
    const assumption = assumptions.get(question.assumption);
    if (!assumption) problems.push(`${id}: names no assumption on the card`);
    else if (assumption.tag !== "unverified" || assumption.productImpacting !== true) {
      problems.push(`${id}: only an unverified product-impacting assumption is a question; proceed on the others`);
    }
  }
  return problems;
}

function planProblems(plan, criterionIds) {
  if (!plan) return ["a locked card needs a plan"];
  const problems = [];
  if (!isText(plan.summary)) problems.push("plan: needs a summary");
  if (list(plan.ownerFiles).length === 0 || list(plan.ownerFiles).some((entry) => !isText(entry))) problems.push("plan: ownerFiles must list the files the change owns");
  for (const entry of list(plan.notTouched)) {
    if (!isText(entry?.path) || !isText(entry?.reason)) problems.push("plan: each notTouched entry needs a path and a reason");
  }
  for (const entry of list(plan.justifications)) {
    if (!isText(entry?.path)) problems.push("plan: each justification needs a path");
    if (!justificationCites(entry, criterionIds)) {
      problems.push(`plan: justification for ${entry?.path} cites neither a criterion on the card nor a requirement with its source`);
    }
  }
  return problems;
}

/** A justification cites a criterion on the card, or a product requirement with the source it came from. */
function justificationCites(entry, criterionIds) {
  return criterionIds.has(entry?.cites) || (isText(entry?.requirement) && isText(entry?.source));
}

function isPlanned(file, ownerFiles) {
  return ownerFiles.some((owner) => (owner.endsWith("/") ? file.startsWith(owner) : file === owner));
}

/**
 * Every changed file outside the plan, split by whether a criterion or requirement is cited for it. This only
 * reports: it never removes a file, never fails the change and never caps its size (blocks is always false).
 */
export function budgetReport(card, changedFiles) {
  const ownerFiles = list(card?.plan?.ownerFiles).filter(isText);
  const criterionIds = new Set(list(card?.criteria).map((criterion) => criterion?.id));
  const cited = new Map(list(card?.plan?.justifications)
    .filter((entry) => isText(entry?.path) && justificationCites(entry, criterionIds))
    .map((entry) => [entry.path, entry.cites ?? entry.source]));
  const extra = changedFiles
    .filter((file) => !isPlanned(file, ownerFiles) && !SESSION_ARTIFACTS.test(file))
    .map((file) => ({ path: file, cites: cited.get(file) ?? null }));
  return {
    blocks: false,
    planned: ownerFiles,
    outsidePlan: extra.length,
    cited: extra.filter((entry) => entry.cites !== null),
    uncited: extra.filter((entry) => entry.cites === null).map((entry) => entry.path),
  };
}

/** The handoff Assumptions field, generated from the card (and the budget report when the diff is known). */
export function assumptionsText(card, report = null) {
  const lines = [];
  const assumptions = list(card?.assumptions);
  for (const tag of ASSUMPTION_TAGS) {
    const group = assumptions.filter((assumption) => assumption.tag === tag);
    lines.push(`${tag === "grounded" ? "Grounded" : "Unverified"}:`);
    if (group.length === 0) lines.push("- None");
    for (const assumption of group) {
      const basis = tag === "grounded" ? `; basis: ${assumption.basis}` : assumption.productImpacting ? "; product-impacting" : "";
      lines.push(`- ${assumption.id}: ${assumption.text}${basis}; falsified by: ${assumption.falsifiedBy}`);
    }
  }
  const answered = list(card?.openQuestions).filter(isAnswered);
  lines.push("Answered before code:");
  if (answered.length === 0) lines.push("- None");
  for (const question of answered) lines.push(`- ${question.id}: ${question.question} -> ${question.answer.text} (${question.answer.source})`);
  lines.push("Deliberately not changed:");
  const notTouched = list(card?.plan?.notTouched);
  if (notTouched.length === 0) lines.push("- None");
  for (const entry of notTouched) lines.push(`- ${entry.path}: ${entry.reason}`);
  if (report) {
    lines.push("Changed outside the plan, with the criterion or requirement cited:");
    if (report.cited.length === 0) lines.push("- None");
    for (const entry of report.cited) lines.push(`- ${entry.path}: ${entry.cites}`);
    lines.push("Changed outside the plan, nothing cited:");
    if (report.uncited.length === 0) lines.push("- None");
    for (const file of report.uncited) lines.push(`- ${file}`);
  }
  return `${lines.join("\n")}\n`;
}

/** One evidence row per criterion for the reviewer to fill in; unknown values are null, never guessed. */
export function evidenceSkeleton(card) {
  return { rows: list(card?.criteria).map((criterion) => ({ criterion: criterion.id, type: criterion.evidence ?? null, ref: null, verdict: null })) };
}

/** A locked card's criteria and assumptions change only through a `superseded` entry that names a source. */
export function lockedChangeProblems(previous, next) {
  const superseded = new Set(list(next?.superseded).filter((entry) => isText(entry?.id) && isText(entry?.source)).map((entry) => entry.id));
  const problems = [];
  const byId = (items) => new Map(list(items).map((item) => [item?.id, item]));
  for (const [kind, before, after] of [["criterion", previous?.criteria, next?.criteria], ["assumption", previous?.assumptions, next?.assumptions]]) {
    const current = byId(after);
    for (const [id, item] of byId(before)) {
      const now = current.get(id);
      if (superseded.has(id)) continue;
      if (!now) problems.push(`${id}: the locked ${kind} was removed with no superseded entry naming a source`);
      else if (item.text !== now.text || (kind === "assumption" && item.tag !== now.tag)) {
        problems.push(`${id}: the locked ${kind} was changed with no superseded entry naming a source`);
      }
    }
  }
  return problems;
}

function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

function cardPath(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), CARD_FILE);
}

function changedFiles(worktree, base) {
  const lines = (output) => output.split("\n").filter(Boolean);
  return [...new Set([...lines(git(worktree, ["diff", "--name-only", base])), ...lines(git(worktree, ["ls-files", "--others", "--exclude-standard"]))])];
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const USAGE = "Usage: spec-card.mjs check <card.json> [--stage draft|locked] [--checkpoint] | save --worktree <path> --stage draft|locked <card.json> | path --worktree <path> | budget --card <card.json> --worktree <path> --base <sha> | assumptions <card.json> [--worktree <path> --base <sha>] | evidence-skeleton <card.json>";

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { stage: { type: "string" }, card: { type: "string" }, worktree: { type: "string" }, base: { type: "string" }, checkpoint: { type: "boolean" } },
  });
  const [command, cardArg] = positionals;
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const stage = values.stage ?? "draft";
  if (!["draft", "locked"].includes(stage)) throw new Error("--stage must be draft or locked");
  if (command === "check" && cardArg) {
    const result = cardProblems(readJson(cardArg), stage);
    const checkpoint = checkpointEnabled(values.checkpoint);
    const blocking = checkpoint ? result.wouldBlock : [];
    print({ ok: result.problems.length === 0 && blocking.length === 0, checkpoint, ...result, blocking });
    return result.problems.length === 0 && blocking.length === 0 ? 0 : 1;
  }
  if (command === "path" && values.worktree) {
    process.stdout.write(`${cardPath(values.worktree)}\n`);
    return 0;
  }
  if (command === "save" && values.worktree && cardArg) {
    const next = readJson(cardArg);
    const target = cardPath(values.worktree);
    const previous = existsSync(target) ? readJson(target) : null;
    const problems = [...cardProblems(next, stage).problems, ...(previous?.stage === "locked" ? lockedChangeProblems(previous, next) : [])];
    if (previous?.stage === "locked" && stage === "draft") problems.push("a locked card cannot go back to draft");
    if (problems.length > 0) {
      print({ ok: false, problems });
      return 1;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ ...next, stage }, null, 2)}\n`);
    print({ ok: true, path: target, stage });
    return 0;
  }
  if (command === "budget" && values.card && values.worktree && values.base) {
    print(budgetReport(readJson(values.card), changedFiles(values.worktree, values.base)));
    return 0;
  }
  if (command === "assumptions" && cardArg) {
    const card = readJson(cardArg);
    const report = values.worktree && values.base ? budgetReport(card, changedFiles(values.worktree, values.base)) : null;
    process.stdout.write(assumptionsText(card, report));
    return 0;
  }
  if (command === "evidence-skeleton" && cardArg) {
    print(evidenceSkeleton(readJson(cardArg)));
    return 0;
  }
  throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
