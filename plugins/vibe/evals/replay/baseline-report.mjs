// M6: turns scored runs into the baseline table later changes are judged against.
// Per class and arm: functional pass rate, criteria, minimality, uncertainty and
// cost. A mean is taken over the runs that measured the field; a field no run
// measured is null ("n/a" in the table). Tickets with fewer than MIN_RUNS scored
// runs are listed, as the noise floor requires.

import { MIN_RUNS } from "./runner.mjs";
import { ReplayResult } from "./results.mjs";

const present = (values) => values.filter((value) => typeof value === "number" && Number.isFinite(value));
const mean = (values) => { const v = present(values); return v.length === 0 ? null : v.reduce((sum, value) => sum + value, 0) / v.length; };

function stdev(values) {
  const v = present(values);
  if (v.length < 2) return null;
  const average = mean(v);
  return Math.sqrt(v.reduce((sum, value) => sum + (value - average) ** 2, 0) / (v.length - 1));
}

function summarize(scores) {
  const decided = scores.map((score) => score.functional.result).filter((result) => result === ReplayResult.Pass || result === ReplayResult.Fail);
  const cost = (field) => mean(scores.map((score) => score.telemetry?.[field]));
  const uncertain = scores.map((score) => score.uncertainty).filter(Boolean);
  const flaggedKnown = uncertain.filter((entry) => entry.unflaggedWrong !== null);
  return {
    runs: scores.length,
    functionalDecided: decided.length,
    functionalPassRate: decided.length === 0 ? null : decided.filter((result) => result === ReplayResult.Pass).length / decided.length,
    functionalBlocked: scores.filter((score) => score.functional.result === ReplayResult.Blocked).length,
    criteriaFraction: mean(scores.map((score) => score.criteriaScore?.fraction)),
    lineRatioMean: mean(scores.map((score) => score.minimality?.lineRatio)),
    lineRatioStdev: stdev(scores.map((score) => score.minimality?.lineRatio)),
    extraFilesMean: mean(scores.map((score) => score.minimality?.extraFiles.length)),
    flagPrecisionMean: mean(uncertain.map((entry) => entry.flagPrecision)),
    unflaggedWrongTotal: flaggedKnown.length === 0 ? null : flaggedKnown.reduce((sum, entry) => sum + entry.unflaggedWrong.length, 0),
    workerLaunchesMean: cost("workerLaunches"),
    wallTimeMsMean: cost("wallTimeMs"),
    inputTokensMean: cost("inputTokens"),
    outputTokensMean: cost("outputTokens"),
    costUsdMean: cost("costUsd"),
    environmentMinutesMean: cost("environmentMinutes"),
    slotWaitMsMean: cost("slotWaitMs"),
  };
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

export function buildReport(scores) {
  const rows = [...groupBy(scores, (score) => JSON.stringify([score.taskClass, score.arm]))].map(([key, group]) => {
    const [taskClass, arm] = JSON.parse(key);
    return { taskClass, arm, ...summarize(group) };
  }).sort((a, b) => (a.taskClass === b.taskClass ? a.arm.localeCompare(b.arm) : a.taskClass.localeCompare(b.taskClass)));
  const underRun = [...groupBy(scores, (score) => JSON.stringify([score.slug, score.arm]))]
    .map(([key, group]) => ({ slug: JSON.parse(key)[0], arm: JSON.parse(key)[1], runs: group.length }))
    .filter((item) => item.runs < MIN_RUNS);
  return { rows, underRun, minRuns: MIN_RUNS };
}

const cell = (value, digits = 2) => (value === null || value === undefined ? "n/a" : Number(value.toFixed(digits)).toString());

export function reportMarkdown(report) {
  const lines = [
    "| Class | Arm | Runs | Functional pass | Criteria | Line ratio (sd) | Extra files | Flag precision | Unflagged wrong | Launches | Wall ms | Tokens in/out | Cost USD | Env min | Slot wait ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of report.rows) {
    lines.push(`| ${row.taskClass} | ${row.arm} | ${row.runs} | ${cell(row.functionalPassRate)} (${row.functionalDecided} decided, ${row.functionalBlocked} blocked) | ${cell(row.criteriaFraction)} | ${cell(row.lineRatioMean)} (${cell(row.lineRatioStdev)}) | ${cell(row.extraFilesMean)} | ${cell(row.flagPrecisionMean)} | ${row.unflaggedWrongTotal ?? "n/a"} | ${cell(row.workerLaunchesMean)} | ${cell(row.wallTimeMsMean, 0)} | ${cell(row.inputTokensMean, 0)}/${cell(row.outputTokensMean, 0)} | ${cell(row.costUsdMean)} | ${cell(row.environmentMinutesMean)} | ${cell(row.slotWaitMsMean, 0)} |`);
  }
  if (report.underRun.length > 0) {
    lines.push("", `Fewer than ${report.minRuns} runs: ${report.underRun.map((item) => `${item.slug} (${item.arm}, ${item.runs})`).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
