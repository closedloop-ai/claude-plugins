import { z } from "zod";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { budgetFailureHead, budgetRefReadArguments, terminatedCommitSchema } from "./main-sync-native-failure.js";
import { validationCommitSchema } from "./main-sync-validation-contracts.js";

const tupleSchema = z.tuple([validationCommitSchema, validationCommitSchema]);
type BudgetRefs = { head: string; main: string };
export type BudgetRefCapture =
  | ({ kind: "complete" } & BudgetRefs)
  | { kind: "proved-first-incomplete"; head: string }
  | { kind: "unproved" };
export type UnprovedBudgetFallback = (root: string, capture: Extract<BudgetRefCapture, { kind: "unproved" }>) => BudgetRefs;
export type ProvedBudgetCompletion = (root: string, capture: Extract<BudgetRefCapture, { kind: "proved-first-incomplete" }>) => BudgetRefs;

/** Captures only the budget's fixed pre-selection refs, never a caller-supplied command. */
export function readBudgetRefs(root: string): BudgetRefs {
  const capture = captureBudgetRefs(root);
  if (capture.kind === "complete") return { head: capture.head, main: capture.main };
  if (capture.kind === "proved-first-incomplete") return completeBudgetMain(root, capture);
  return fallbackBudgetRefs(root, capture);
}

function captureBudgetRefs(root: string): BudgetRefCapture {
  let output: string;
  try { output = git(root, [...budgetRefReadArguments]); }
  catch (error) {
    const first = budgetFailureHead(error);
    return first.kind === "proved" ? { kind: "proved-first-incomplete", head: first.head } : first;
  }
  const tuple = tupleSchema.safeParse(output.split("\n"));
  if (tuple.success) return { kind: "complete", head: tuple.data[0], main: tuple.data[1] };
  const first = terminatedCommitSchema.safeParse(output);
  return first.success ? { kind: "proved-first-incomplete", head: first.data } : { kind: "unproved" };
}

const fallbackBudgetRefs: UnprovedBudgetFallback = (root, _capture) => {
  const head = git(root, ["rev-parse", "HEAD"]);
  const main = git(root, ["rev-parse", "origin/main"]);
  return { head, main };
};
const completeBudgetMain: ProvedBudgetCompletion = (root, capture) => ({
  head: capture.head, main: git(root, ["rev-parse", "origin/main"]),
});
