import { lstatSync, readFileSync } from "node:fs";
import { providerDataOr, ticketReference } from "../../vibe/scripts/provider.mjs";

export class BodyFileError extends Error {}

/** Read one bounded literal PR body file or return a path-specific refusal. */
export function readPrBodyFile(bodyFile, maxBytes = 65536) {
  if (!bodyFile) throw new BodyFileError("the PR body-file path is missing or could not be read");
  try {
    const stat = lstatSync(bodyFile);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    return readFileSync(bodyFile, "utf8");
  } catch (error) {
    throw new BodyFileError(`PR body-file ${JSON.stringify(bodyFile)} could not be read: ${error.message}`);
  }
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
