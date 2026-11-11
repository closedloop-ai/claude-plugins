import { issueKey, requirementsKey } from "../../vibe/scripts/tracker-key.mjs";
const IMAGE = /\.(?:png|jpe?g|webp)$/i;
const BASELINE_PATH = /(?:^|\/)(?:__screenshots__|snapshots?|baselines?|goldens?)(?:\/|$)/i;
// A cited human source: a tracker ticket's criterion or ruling (tracker-key.mjs), or an operator ruling.
const humanSource = () => new RegExp(String.raw`^(?:(?:${issueKey()}|${requirementsKey()})\s+(?:AC(?:-?\d+)?|acceptance criterion|ruling)\b|operator ruling\b)`, "i");

/** Whether a changed path is a visual test baseline rather than an ordinary image asset. */
export function isVisualBaseline(file) {
  return IMAGE.test(file) && BASELINE_PATH.test(file);
}

function entries(body, label, file) {
  const prefix = `${label}: ${file}:`;
  return body.split("\n").filter((line) => line.trimStart().startsWith(prefix)).map((line) => line.trim().slice(prefix.length).trim());
}

/**
 * Requires a counted element inventory for each changed visual baseline.
 * Reviewers compare the declared count and sources with the rendered diff.
 */
export function visualBaselineLedgerProblems(body, files) {
  const problems = [];
  for (const file of [...new Set(files.filter(isVisualBaseline))]) {
    const inventories = entries(body, "Baseline inventory", file);
    if (inventories.length !== 1) {
      problems.push(`${file}: needs exactly one \`Baseline inventory: <file>: <surface>: <N> new elements\` line`);
      continue;
    }
    const inventory = /^(.*?):\s*(\d+)\s+new elements?$/.exec(inventories[0]);
    if (!inventory) {
      problems.push(`${file}: baseline inventory must end with \`<N> new elements\``);
      continue;
    }
    const surface = inventory[1].trim();
    const expected = Number(inventory[2]);
    const elements = entries(body, "Baseline element", file);
    if (elements.length !== expected) {
      problems.push(`${file}: baseline inventory declares ${expected} new elements but lists ${elements.length}`);
    }
    for (const element of elements) {
      const parsed = /^(.*?):\s*(.*?):\s*(.*)$/.exec(element);
      if (!parsed || parsed[1].trim() !== surface || !parsed[2].trim() || !humanSource().test(parsed[3].trim())) {
        problems.push(`${file}: each \`Baseline element\` must name the inventory surface, the element, and its ticket acceptance criterion or ruling; "plausibly intended" is not a source`);
      }
    }
  }
  return problems;
}
