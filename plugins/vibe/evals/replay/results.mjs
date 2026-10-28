// Outcome vocabulary of a replay score. A check that could not run is BLOCKED
// with a reason, a check that does not apply is NOT_APPLICABLE; neither is ever
// reported as PASS or FAIL.

export const ReplayResult = {
  Pass: "PASS",
  Fail: "FAIL",
  Blocked: "BLOCKED",
  NotApplicable: "NOT_APPLICABLE",
};
