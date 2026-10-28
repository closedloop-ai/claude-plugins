// M5: uncertainty and rework scoring. Compares the assumptions a run flagged as
// unverified with what reviewers (or the human change) showed was wrong. The
// matching is given as labels, never guessed from wording: a reviewer, or a
// judge the caller injects, says which finding each flagged assumption is.
//
// input = {
//   flagged:  [{id, text}] | null,             // the run's flagged unverified assumptions;
//                                              // null while no run records them (the Spec Card
//                                              // and handoff assumptions section, WS2 S1/S4)
//   findings: [{id, text, wrongAssumption: boolean, flaggedAs?: string | null}],
//                                              // review comments / human choices, labeled;
//                                              // flaggedAs is the flagged assumption id it matches
//   rework:   {fixCommits?, reviewRounds?, designGrade?, engGrade?, survival14?, survival30?}
//                                              // taken as given; code-stickiness and the ticket
//                                              // handoff grades are read by the caller, not here
// }
//
// With `flagged` null, everything that needs the flags is null: flagged count,
// matches, precision and the unflagged-wrong count. Review findings and rework
// are still scored.

const GRADES = new Set(["High", "Medium", "Low"]);
const REWORK_COUNTS = ["fixCommits", "reviewRounds"];
const REWORK_PERCENTS = ["survival14", "survival30"];
const REWORK_GRADES = ["designGrade", "engGrade"];

function reworkSignals(rework = {}) {
  for (const field of REWORK_COUNTS) {
    if (rework[field] != null && !(Number.isInteger(rework[field]) && rework[field] >= 0)) throw new Error(`${field} must be a non-negative integer.`);
  }
  for (const field of REWORK_PERCENTS) {
    if (rework[field] != null && !(Number.isFinite(rework[field]) && rework[field] >= 0 && rework[field] <= 100)) throw new Error(`${field} must be a percentage from 0 to 100.`);
  }
  for (const field of REWORK_GRADES) {
    if (rework[field] != null && !GRADES.has(rework[field])) throw new Error(`${field} must be High, Medium or Low.`);
  }
  return Object.fromEntries([...REWORK_COUNTS, ...REWORK_PERCENTS, ...REWORK_GRADES].map((field) => [field, rework[field] ?? null]));
}

const ratio = (top, bottom) => (bottom === 0 ? null : top / bottom);

export function scoreUncertainty({ flagged = null, findings = [], rework } = {}) {
  const wrong = findings.filter((finding) => finding.wrongAssumption === true);
  const base = { wrongFindings: wrong.length, rework: reworkSignals(rework) };
  if (flagged === null) {
    return { ...base, flagged: null, flaggedMatchedReview: null, unflaggedWrong: null, flagPrecision: null, wrongCaught: null };
  }
  const ids = new Set(flagged.map((item) => item.id));
  const matchedIds = new Set(wrong.map((finding) => finding.flaggedAs).filter((id) => typeof id === "string" && ids.has(id)));
  const unflaggedWrong = wrong.filter((finding) => !(typeof finding.flaggedAs === "string" && ids.has(finding.flaggedAs)));
  return {
    ...base,
    flagged: flagged.length,
    flaggedMatchedReview: [...matchedIds].sort(),
    unflaggedWrong: unflaggedWrong.map((finding) => finding.id),
    flagPrecision: ratio(matchedIds.size, flagged.length),
    wrongCaught: ratio(matchedIds.size, matchedIds.size + unflaggedWrong.length),
  };
}
