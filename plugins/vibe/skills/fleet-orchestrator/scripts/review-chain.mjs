#!/usr/bin/env node
// Which review the orchestrator runs on a pull request's head: its own full
// independent chain (the default, unchanged), or only a check that the
// writer's fixes landed, when the writer's handoff review already covered
// this exact head. Changes nothing.
//
// Usage: review-chain.mjs --pr-head <sha> [--handoff-reviewed-head <sha>] [--enable]
// Prints one JSON object { schema, mode, reason } with mode `full-chain` or
// `verify-fixes-only`; exit 0 whenever it printed a decision, 2 on bad usage.
//
// Off unless `--enable` or FLEET_REVIEW_HANDOFF_ONLY=1. Whether the orchestrator's
// review chain is intentionally separate from the handoff review is an OPEN
// owner decision (vibe-fleet-optimization-plan, WS4 R4), so the default keeps
// both. `verify-fixes-only` needs the head the writer's handoff review reports
// having covered, passed in by the orchestrator, and that head must be the
// pull request's head: any commit after the handoff review is unreviewed, so a
// missing, malformed or different head is `full-chain`.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const REVIEW_CHAIN_SCHEMA = "vibe.fleet-review-chain/1";
export const ReviewChain = { Full: "full-chain", VerifyFixesOnly: "verify-fixes-only" };
const SHA = /^[0-9a-f]{7,40}$/i;

/** The chain to run for `prHead`; anything short of an enabled switch and a matching reviewed head is the full chain. */
export function chooseReviewChain({ enabled, prHead, handoffReviewedHead }) {
  const full = (reason) => ({ mode: ReviewChain.Full, reason });
  if (!enabled) return full("handoff-only review switch is off");
  if (!SHA.test(prHead ?? "")) return full("pull request head is not a SHA");
  if (!handoffReviewedHead) return full("no handoff-reviewed head given");
  if (!SHA.test(handoffReviewedHead)) return full("handoff-reviewed head is not a SHA");
  const [pr, reviewed] = [prHead.toLowerCase(), handoffReviewedHead.toLowerCase()];
  const same = pr.startsWith(reviewed) || reviewed.startsWith(pr);
  return same
    ? { mode: ReviewChain.VerifyFixesOnly, reason: "the handoff review covered this head" }
    : full("the head moved after the handoff review");
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    "pr-head": { type: "string" }, "handoff-reviewed-head": { type: "string" }, enable: { type: "boolean" },
  } });
  if (!values["pr-head"]) throw new Error("--pr-head is required");
  const enabled = Boolean(values.enable) || process.env.FLEET_REVIEW_HANDOFF_ONLY === "1";
  const decision = chooseReviewChain({ enabled, prHead: values["pr-head"], handoffReviewedHead: values["handoff-reviewed-head"] });
  process.stdout.write(`${JSON.stringify({ schema: REVIEW_CHAIN_SCHEMA, ...decision })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
