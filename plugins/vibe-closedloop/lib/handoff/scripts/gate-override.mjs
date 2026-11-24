import { readEvidence } from "./handoff-evidence.mjs";
import { providerDataOr, ticketReference } from "../../vibe/scripts/provider.mjs";

export class BodyFileError extends Error {}

/** The named checks a ticketed PR-body override may cover. */
export const OVERRIDE_CHECKS = Object.freeze({
  HeadOwnership: "head ownership", SessionRecord: "session record", HandoffGate: "handoff gate", VisualQa: "visual QA",
});

/** Read one bounded literal PR body file or return a path-specific refusal. */
export function readPrBodyEvidence(bodyFile, maxBytes = 65536) {
  if (!bodyFile) throw new BodyFileError("the PR body-file path is missing or could not be read");
  try {
    return readEvidence(bodyFile, undefined, maxBytes);
  } catch (error) {
    throw new BodyFileError(`PR body-file ${JSON.stringify(bodyFile)} could not be read: ${error.message}`);
  }
}

/** Return the literal text for consumers that do not retain a fingerprint. */
export function readPrBodyFile(bodyFile, maxBytes) {
  return readPrBodyEvidence(bodyFile, maxBytes).text;
}

/** Parsed ticketed override lines. Every reference in a comma-separated list must match the bound tracker. */
export function gateOverrideEntries(body, binding) {
  const issue = providerDataOr(binding, "tickets", "issuePattern", null)?.replace(/^\^/, "").replace(/\$$/, "");
  const reference = `(?:${issue ?? ticketReference(binding).source})`;
  const declaration = new RegExp(`^Vibe gate override:\\s*(?<tickets>${reference}(?:\\s*,\\s*${reference})*)\\s*:\\s*(?<reason>\\S.*)$`);
  return String(body ?? "").split(/\r?\n/).flatMap((line) => {
    const match = declaration.exec(line);
    return match?.groups ? [{ tickets: match.groups.tickets.split(/\s*,\s*/), reason: match.groups.reason }] : [];
  });
}

/** An entry must name only recognized checks and contain a specific reason. */
export function overriddenChecks(body, binding) {
  const covered = new Set();
  const known = new Map(Object.values(OVERRIDE_CHECKS).map((check) => [check.toLowerCase(), check]));
  for (const { reason } of gateOverrideEntries(body, binding)) {
    const names = /^([^:]+):\s*\S/.exec(reason)?.[1].split(",").map((check) => check.trim().toLowerCase()) ?? [];
    if (names.length > 0 && names.every((check) => known.has(check))) {
      for (const check of names) covered.add(known.get(check));
    }
  }
  return covered;
}
