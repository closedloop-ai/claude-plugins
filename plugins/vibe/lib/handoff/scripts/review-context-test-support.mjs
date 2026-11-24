import { formatReviewContext } from "./review-context.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";

/** A versioned ticket and a separate operator amendment for native launch boundary tests. */
export function reviewBrief(directory, text = "Review the changes.", ticket = "TASK-42") {
  const body = "## Acceptance criteria\n1. Keep the original label.\n";
  const ruling = `- Ruling 2026-01-03 (operator message: transcript 1): ${ticket} keeps that label on mobile too.`;
  const snapshot = path.join(directory, "review-ticket.json");
  const program = path.join(directory, "fixture-rulings.md");
  writeFileSync(program, ruling);
  writeFileSync(snapshot, JSON.stringify({ slug: ticket, latestVersion: 3, version: { version: 3, content: body, contentTruncated: false } }));
  return text + "\n\n" + formatReviewContext(ticket, snapshot, program);
}
