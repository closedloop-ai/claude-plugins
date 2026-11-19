/**
 * The one fleet rule for placing a ticket in cloud or on the local writer.
 * The same decision is reported by dispatch-route and enforced by cloud-worker.
 */
export function decideCloudPlacement(input) {
  if (!input || typeof input !== "object") return { placement: "local", reason: "cloud placement evidence is missing" };
  if (input.codeOnly !== true) return { placement: "local", reason: "ticket is not confirmed code-only" };
  if (input.needsRunningApp !== false) return { placement: "local", reason: "ticket needs the running app or its status is unknown" };
  if (!Array.isArray(input.localEvidence)) return { placement: "local", reason: "local evidence requirements are unknown" };
  const evidence = input.localEvidence.find((item) => typeof item !== "string" || item.trim().length === 0);
  if (evidence !== undefined) return { placement: "local", reason: "local evidence requirements are invalid" };
  if (input.localEvidence.length > 0) return { placement: "local", reason: `ticket needs local evidence: ${input.localEvidence.join(", ")}` };
  return { placement: "cloud", reason: "code-only ticket needs neither running app nor local evidence" };
}
