#!/usr/bin/env node
// Human QA only when nothing else can do it. The default is zero human
// checkpoints: an agent verifies what it can, and judges a screenshot against
// the saved reference itself. A checkpoint goes to the operator only for a
// reason an agent cannot cover: a real device or its feel, assistive
// technology, a flow an agent cannot drive (real sign-in, OS dialogs,
// hardware, a third-party screen), or a product call no reference settles.
//
// Usage: qa-plan-check.mjs --plan <QA record> [--criteria <ticket body> [--prd <PRD body>]]
//
// Reads each `### <ID>: <title>` checkpoint and its `- Routing:` line (the
// guided-manual-qa record). A routing that starts with AGENT_VERIFIED or
// E2E_COVERED is the agent's; any other routing is a human checkpoint and
// must give a reason from the list above. Prints `HUMAN <id>: <reason>` for
// each accepted one and `REFUSED <id>: <why>` for each refused one, then
// `human checkpoints: <n>, refused: <n>`; exits 1 when any is refused.
// With --criteria, every rollout, flag and rollback requirement of the ticket
// and its PRD (handoff's rollout-gate.mjs) must be a checkpoint the plan cites
// by its ID; it prints `MISSING-ROLLOUT <id>: <text>` otherwise. A PRD's
// rollout gate was once skipped and no QA step checked it.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { rolloutRequirements } from "../../handoff/scripts/rollout-gate.mjs";

const CHECKPOINT = /^###\s+([A-Za-z0-9_-]+):/;
const ROUTING = /^-\s*Routing[^:]*:\s*(.*)$/;
const AGENT = /^`?(?:AGENT_VERIFIED|E2E_COVERED)\b/;
const HUMAN_ONLY = /\b(?:real device|physical device|on-device|device feel|(?:touch|scroll|gesture) feel|assistive|screen reader|voiceover|talkback|os dialog|system dialog|oauth|real sign-in|hardware|camera|microphone|third-party|cannot drive|can't drive|product (?:judgment|call|decision))\b/i;
const VISUAL_ONLY = /\b(?:visual|layout|looks?|overlap|spacing|alignment|colou?r|screenshot|perceptual|pixel|render(?:s|ing)?)\b/i;

/** Every checkpoint of a QA record with its routing line, or null when it has none. */
export function checkpoints(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const heading = CHECKPOINT.exec(line);
    if (heading) {
      found.push({ id: heading[1], routing: null });
      continue;
    }
    const routing = ROUTING.exec(line);
    if (routing && found.length > 0 && found.at(-1).routing === null) {
      found.at(-1).routing = routing[1].trim();
    }
  }
  return found;
}

/** Rollout requirements no checkpoint in `plan` cites by ID. */
export function missingRolloutCheckpoints(plan, ticket, prd = "") {
  return rolloutRequirements(ticket, prd).filter(({ id }) => !new RegExp(`\\b${id}\\b`).test(plan));
}

/** The verdict for one checkpoint: agent, human (with its reason) or refused (with why). */
export function verdict({ routing }) {
  if (routing === null || routing === "") {
    return { kind: "refused", why: "no Routing line; route it to the agent with its evidence, or give the reason it needs a human" };
  }
  if (AGENT.test(routing)) {
    return { kind: "agent" };
  }
  if (HUMAN_ONLY.test(routing)) {
    return { kind: "human", reason: routing };
  }
  if (VISUAL_ONLY.test(routing)) {
    return { kind: "refused", why: "a visual judgment is the agent's: compare its screenshot with the saved reference and record AGENT_VERIFIED" };
  }
  return { kind: "refused", why: "no reason an agent cannot cover (real device or feel, assistive technology, a flow it cannot drive, a product call)" };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { plan: { type: "string" }, criteria: { type: "string" }, prd: { type: "string" } } });
  if (!values.plan) {
    throw new Error("Usage: qa-plan-check.mjs --plan <QA record>");
  }
  let human = 0;
  let refused = 0;
  const plan = readFileSync(values.plan, "utf8");
  const missing = values.criteria ? missingRolloutCheckpoints(plan, readFileSync(values.criteria, "utf8"), values.prd ? readFileSync(values.prd, "utf8") : "") : [];
  for (const requirement of missing) process.stdout.write(`MISSING-ROLLOUT ${requirement.id}: ${requirement.text.slice(0, 120)}\n`);
  refused += missing.length;
  for (const checkpoint of checkpoints(plan)) {
    const result = verdict(checkpoint);
    if (result.kind === "human") {
      human += 1;
      process.stdout.write(`HUMAN ${checkpoint.id}: ${result.reason}\n`);
    } else if (result.kind === "refused") {
      refused += 1;
      process.stdout.write(`REFUSED ${checkpoint.id}: ${result.why}\n`);
    }
  }
  process.stdout.write(`human checkpoints: ${human}, refused: ${refused}\n`);
  return refused === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
