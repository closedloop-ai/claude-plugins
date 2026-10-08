import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import { sessionLiveTicket } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { identifierSchema } from "./contracts.js";
import { checkoutLocation, location } from "./ledger.js";

export const recordModes: Record<string, Record<string, readonly string[]>> = {
  "vibe-setup-worker": { create: ["create_document"], progress: ["create_document_version"], discard: [] },
  "vibe-change-worker": { progress: ["create_document_version"] },
  "vibe-ticket-worker": { create: ["create_document"], handoff: ["create_document_version", "upload_attachment"],
    assign: ["update_document"], cancel: ["create_document_version", "update_document"] },
  "vibe-environment-worker": { create: ["create_document_version"], redeploy: ["create_document_version"],
    flags: ["create_document_version"], desktop: ["create_document_version"] },
  "vibe-prototype-worker": { share: ["create_document_version"] },
};

export const recordContextSchema = z.object({
  worktree: z.string().min(1), agentName: identifierSchema,
  mode: z.enum(["plan", "request", "fix", "handoff", "record"]),
  recordAction: z.enum(["progress", "create", "handoff", "assign", "cancel", "redeploy", "flags", "desktop", "share", "discard"]).optional(),
  exclusiveRecordTurn: z.literal(true).optional(),
  discardTarget: z.object({ worktree: z.string().min(1), confirmed: z.literal(true),
    branch: z.string().regex(/^(?:vibe|prototype)\/[^\s]+$/), liveTicket: z.string().regex(/^[A-Z]+-\d+$/).optional(),
    operatorId: z.string().min(1), operatorEmail: z.string().email(),
  }).strict().optional(),
  sessionless: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("startup") }).strict(),
    z.object({ kind: z.literal("discarded"), evidence: z.object({ discarded: z.literal(true),
      branch: z.string().regex(/^(?:vibe|prototype)\/[^\s]+$/), liveTicket: z.string().regex(/^[A-Z]+-\d+$/),
      operatorId: z.string().min(1), operatorEmail: z.string().email(),
    }).strict() }).strict(),
  ]).optional(),
}).strict();
type RecordContext = z.infer<typeof recordContextSchema>;

/** Both runtimes resolve the same bounded role/action and stable sessionless contexts. */
export function resolveRecordContext(input: RecordContext) {
  if (input.recordAction === "discard" && !input.discardTarget) throw new Error("Discard requires parent-held target and confirmation evidence");
  if (input.discardTarget && (input.agentName !== "vibe-setup-worker" || input.mode !== "record"
    || input.recordAction !== "discard" || !input.exclusiveRecordTurn || input.sessionless?.kind !== "startup")) {
    throw new Error("Discard executes only through setup's exclusive stable-checkout operation");
  }
  let place;
  if (input.sessionless) {
    const startupRole = input.agentName === "vibe-requirements-worker" || input.agentName === "vibe-setup-worker";
    const startup = input.sessionless.kind === "startup" && startupRole && input.mode !== "handoff";
    const cancel = input.sessionless.kind === "discarded" && input.agentName === "vibe-ticket-worker"
      && input.mode === "record" && input.recordAction === "cancel" && input.exclusiveRecordTurn;
    if (!startup && !cancel) throw new Error("This role/action has no sessionless operation");
    place = checkoutLocation(input.worktree);
    if (existsSync(join(place.dir, "vibe-session.json"))) throw new Error("A private session exists; use its strict owned operation");
  } else place = location(input.worktree);
  return { place, target: discardLocation(input, place) };
}

/** The target's private ownership is independent of the retained execution checkout. */
function discardLocation(input: RecordContext, stable: ReturnType<typeof checkoutLocation>) {
  if (!input.discardTarget) return undefined;
  const evidence = input.discardTarget;
  const target = location(evidence.worktree);
  const record = z.object({ branch: z.string(), status: z.literal("active"), liveTicket: z.string().nullable().optional(),
    handoffTicket: z.string().nullable().optional(),
    operator: z.object({ id: z.string().min(1), email: z.string().email() }).passthrough() }).passthrough().parse(
      JSON.parse(readFileSync(join(target.dir, "vibe-session.json"), "utf8")));
  if (target.root === stable.root || stable.root.startsWith(`${target.root}${sep}`)
    || !existsSync(join(target.dir, "commondir"))) throw new Error("Discard must retain its execution checkout");
  const common = readFileSync(join(target.dir, "commondir"), "utf8").trim();
  const stableCommon = existsSync(join(stable.dir, "commondir"))
    ? realpathSync(join(stable.dir, readFileSync(join(stable.dir, "commondir"), "utf8").trim())) : realpathSync(stable.dir);
  if (realpathSync(join(target.dir, common)) !== stableCommon
    || record.branch !== evidence.branch || record.operator.id !== evidence.operatorId
    || record.operator.email !== evidence.operatorEmail || (sessionLiveTicket(record) ?? undefined) !== evidence.liveTicket) {
    throw new Error("Discard target does not match the parent's owned session evidence");
  }
  return target;
}
