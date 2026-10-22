import { z } from "zod";
import { MainSyncError } from "./main-sync-contracts.js";

export const ciStepSchema = z.object({ number: z.number().int().positive(), name: z.string(),
  status: z.string(), conclusion: z.string().nullable(), started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable() }).passthrough();
export type CiStep = z.infer<typeof ciStepSchema>;
const LOG_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
const COLOR_SEQUENCE = /\u001b\[[0-9;]*m/g;
const CHECKOUT_COMMAND = /^\[command\]\/usr\/bin\/git log -1 --format=%H$/;
const SHA = /^[a-f0-9]{40}$/;
const ENV_SHA = /^  DD_GIT_COMMIT_SHA: ([a-f0-9]{40})$/;
const SELECTOR = /^  (DESKTOP_E2E_SMOKE_TAG|DESKTOP_E2E_CHANGED_SPECS):\s*(.*)$/;
type Event = { seconds: number; text: string };

/** Consumes only trusted checkout-action and pre-test runner header evidence, never later test stdout. */
export function checkedSourceFromJobLog(log: string, checkout: CiStep, test: CiStep, expectedCommand: string) {
  const events = log.replace(COLOR_SEQUENCE, "").split("\n").flatMap((line): Event[] => {
    const match = LOG_LINE.exec(line.replace(/\r$/, ""));
    if (!match) return [];
    const stamp = Date.parse(match[1]!);
    return Number.isFinite(stamp) ? [{ seconds: Math.floor(stamp / 1000), text: match[2]! }] : [];
  });
  const checkoutEvents = stepEvents(events, checkout);
  const shaCandidates = checkoutEvents.flatMap((event, index) => {
    const next = checkoutEvents[index + 1];
    return CHECKOUT_COMMAND.test(event.text) && next && SHA.test(next.text) ? [next.text] : [];
  });
  if (shaCandidates.length !== 1) throw new MainSyncError("CI checkout action identity is missing or ambiguous");
  const testEvents = stepEvents(events, test);
  const start = testEvents.findIndex((event) => event.text === `##[group]Run ${expectedCommand}`
    && event.seconds === Math.floor(Date.parse(test.started_at!) / 1000));
  const end = testEvents.findIndex((event, index) => index > start && event.text === "##[endgroup]");
  if (start < 0 || end < 0) throw new MainSyncError("CI pre-test runner header is missing or ambiguous");
  const header = testEvents.slice(start + 1, end);
  const env = header.flatMap((event) => { const match = ENV_SHA.exec(event.text); return match ? [match[1]!] : []; });
  const selectors = header.flatMap((event) => { const match = SELECTOR.exec(event.text); return match ? [{ key: match[1]!, value: match[2]! }] : []; });
  const scopeComplete = ["DESKTOP_E2E_SMOKE_TAG", "DESKTOP_E2E_CHANGED_SPECS"].every((key) => {
    const found = selectors.filter((item) => item.key === key);
    return found.length === 1 && found[0]!.value === "";
  });
  if (env.length !== 1 || env[0] !== shaCandidates[0] || !scopeComplete) {
    throw new MainSyncError("CI runner source/full-scope identity does not match the trusted checkout");
  }
  return shaCandidates[0]!;
}

function stepEvents(events: Event[], step: CiStep) {
  if (step.status !== "completed" || step.conclusion !== "success" || !step.started_at || !step.completed_at) {
    throw new MainSyncError("Required CI step did not complete successfully");
  }
  const start = Math.floor(Date.parse(step.started_at) / 1000);
  const end = Math.floor(Date.parse(step.completed_at) / 1000);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new MainSyncError("CI step identity window is invalid");
  return events.filter((event) => event.seconds >= start && event.seconds <= end);
}
