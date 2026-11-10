import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import { sessionLiveTicket } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { identifierSchema } from "./contracts.js";
import { checkoutLocation, location, sessionPlace } from "./ledger.js";
import { validationWitnessSchema } from "./main-sync-validation-contracts.js";

export const recordModes: Record<string, Record<string, readonly string[]>> = {
  "vibe-setup-worker": { create: ["create_document"], progress: ["create_document_version"], discard: [] },
  "vibe-change-worker": { progress: ["create_document_version"] },
  "vibe-ticket-worker": { create: ["create_document", "create_artifact_link"],
    plan: ["create_document", "create_document_version", "create_artifact_link", "update_document"],
    handoff: ["create_document", "create_document_version", "create_artifact_link", "update_document", "upload_attachment"],
    assign: ["update_document"], cancel: ["create_document_version", "update_document"] },
  "vibe-environment-worker": { create: ["create_document_version"], redeploy: ["create_document_version"],
    flags: ["create_document_version"], desktop: ["create_document_version"], handover: ["create_document_version"], "pull-request": [] },
  "vibe-prototype-worker": { share: ["create_document_version"] },
};

export const recordActionSchema = z.enum(["progress", "create", "plan", "handoff", "assign", "cancel", "redeploy", "flags", "desktop", "share",
  "discard", "handover", "pull-request"]);
export const requestContinuationSchema = z.object({ runtime: z.enum(["codex", "claude"]),
  requestId: identifierSchema, recordAction: z.enum(["flags", "desktop"]) }).strict();
export type RequestContinuation = z.infer<typeof requestContinuationSchema>;
export const ciRunLocatorSchema = z.object({ runId: z.number().int().positive().safe(),
  attempt: z.number().int().positive().safe() }).strict();
export const recordContextSchema = z.object({
  worktree: z.string().min(1), agentName: identifierSchema,
  mode: z.enum(["plan", "request", "fix", "handoff", "pull-request", "record"]),
  recordAction: recordActionSchema.optional(),
  exclusiveRecordTurn: z.literal(true).optional(),
  publicationPurpose: z.enum(["build", "handoff"]).optional(),
  mainSyncTransactionId: z.string().uuid().optional(),
  mainSyncRequestContinuations: z.array(requestContinuationSchema).min(1).max(2).optional(),
  mainSyncCiRun: ciRunLocatorSchema.optional(),
  mainSyncValidation: validationWitnessSchema.optional(),
  discardTarget: z.object({ worktree: z.string().min(1), confirmed: z.literal(true),
    branch: z.string().regex(/^(?:vibe|prototype)\/[^\s]+$/), liveTicket: z.string().regex(/^[A-Z]+-\d+$/).optional(),
    liveTicketCreatedBySession: z.boolean(),
    operatorId: z.string().min(1), operatorEmail: z.string().email(),
  }).strict().optional(),
  sessionless: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("startup") }).strict(),
    z.object({ kind: z.literal("discarded"), evidence: z.object({ discarded: z.literal(true),
      branch: z.string().regex(/^(?:vibe|prototype)\/[^\s]+$/), liveTicket: z.string().regex(/^[A-Z]+-\d+$/),
      liveTicketCreatedBySession: z.literal(true),
      operatorId: z.string().min(1), operatorEmail: z.string().email(),
    }).strict() }).strict(),
    z.object({ kind: z.literal("takeover"), evidence: z.object({
      prUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/),
      headSha: z.string().regex(/^[0-9a-f]{40}$/),
      /** The PR's source branch the root pushes the repair to; required for the takeover writer. */
      sourceBranch: z.string().min(1).regex(/^[^\s]+$/).optional(),
    }).strict() }).strict(),
  ]).optional(),
}).strict();
type RecordContext = z.infer<typeof recordContextSchema>;

/** Existing publication rights are exact role/action tuples, never the presence of Write or Bash. */
export function isPublisherContext(input: Pick<RecordContext, "agentName" | "mode" | "recordAction" | "exclusiveRecordTurn">) {
  return input.mode === "record" && input.exclusiveRecordTurn === true
    && ((input.agentName === "vibe-environment-worker" && ["create", "redeploy"].includes(input.recordAction ?? ""))
      || (input.agentName === "vibe-prototype-worker" && input.recordAction === "share"));
}

/**
 * A vibe tooling stop hands the work to engineering: the environment worker pushes the orchestrator's commit through
 * the repo's normal pre-push checks, with no main sync and no environment request (ISS-13321).
 */
export function isHandoverContext(input: Pick<RecordContext, "agentName" | "mode" | "recordAction" | "exclusiveRecordTurn">) {
  return input.mode === "record" && input.exclusiveRecordTurn === true && input.agentName === "vibe-environment-worker"
    && input.recordAction === "handover";
}

/** Flags/Desktop consume a verified transaction under their own request-only grant. */
export function isRequestContext(input: Pick<RecordContext, "agentName" | "mode" | "recordAction" | "exclusiveRecordTurn">) {
  return input.mode === "record" && input.exclusiveRecordTurn === true && input.agentName === "vibe-environment-worker"
    && ["create", "redeploy", "flags", "desktop"].includes(input.recordAction ?? "");
}

/** Both runtimes resolve the same bounded role/action and stable sessionless contexts. */
export function resolveRecordContext(input: RecordContext) {
  if (input.mainSyncValidation && (input.agentName !== "vibe-change-worker" || input.mode !== "record"
    || input.recordAction !== "progress" || !input.exclusiveRecordTurn
    || input.mainSyncValidation.transactionId !== input.mainSyncTransactionId || !input.publicationPurpose || input.sessionless)) {
    throw new Error("Canonical validation witness belongs only to the Root source validation continuation");
  }
  if (input.mainSyncCiRun && (input.agentName !== "vibe-change-worker" || input.mode !== "record"
    || input.recordAction !== "progress" || !input.exclusiveRecordTurn || input.publicationPurpose !== "handoff")) {
    throw new Error("External CI locators require the actual source handoff-validation grant");
  }
  if (input.mainSyncRequestContinuations && (input.agentName !== "vibe-environment-worker" || !isPublisherContext(input))) {
    throw new Error("Only an actual environment publisher grant may predeclare request continuations");
  }
  if (input.mainSyncRequestContinuations && new Set(input.mainSyncRequestContinuations.map((item) =>
    `${item.runtime}:${item.requestId}:${item.recordAction}`)).size !== input.mainSyncRequestContinuations.length) {
    throw new Error("Parent request continuations must identify distinct exact requests");
  }
  if (input.recordAction === "discard" && !input.discardTarget) throw new Error("Discard requires parent-held target and confirmation evidence");
  if (input.discardTarget && (input.agentName !== "vibe-setup-worker" || input.mode !== "record"
    || input.recordAction !== "discard" || !input.exclusiveRecordTurn || input.sessionless?.kind !== "startup")) {
    throw new Error("Discard executes only through setup's exclusive stable-checkout operation");
  }
  let place;
  if (input.sessionless) {
    const startup = input.sessionless.kind === "startup" && STARTUP_ROLES.has(input.agentName) && input.mode !== "handoff"
      && input.mode !== "pull-request";
    const cancel = input.sessionless.kind === "discarded" && input.agentName === "vibe-ticket-worker"
      && input.mode === "record" && input.recordAction === "cancel" && input.exclusiveRecordTurn;
    const takeover = input.sessionless.kind === "takeover" && !input.recordAction && !input.exclusiveRecordTurn
      && ((TAKEOVER_REVIEWERS.has(input.agentName) && input.mode === "pull-request")
        || (input.agentName === TAKEOVER_WRITER && input.mode !== "record" && input.mode !== "plan"
          && Boolean(input.sessionless.evidence.sourceBranch)));
    if (!startup && !cancel && !takeover) throw new Error("This role/action has no sessionless operation");
    place = checkoutLocation(input.worktree);
    if (existsSync(join(place.dir, "vibe-session.json"))) throw new Error("A private session exists; use its strict owned operation");
  } else {
    const checkout = checkoutLocation(input.worktree);
    if (!existsSync(join(checkout.dir, "vibe-session.json"))) throw new MissingSessionError(input.agentName);
    place = sessionPlace(checkout);
  }
  return { place, target: discardLocation(input, place) };
}

/** The target's private ownership is independent of the retained execution checkout. */
function discardLocation(input: RecordContext, stable: ReturnType<typeof checkoutLocation>) {
  if (!input.discardTarget) return undefined;
  const evidence = input.discardTarget;
  const target = location(evidence.worktree);
  const record = z.object({ branch: z.string(), status: z.literal("active"), liveTicket: z.string().nullable().optional(),
    liveTicketCreatedBySession: z.boolean().optional(),
    handoffTicket: z.string().nullable().optional(),
    operator: z.object({ id: z.string().min(1), email: z.string().email() }).passthrough() }).passthrough().parse(
      JSON.parse(readFileSync(join(target.dir, "vibe-session.json"), "utf8")));
  const recordedTicket = sessionLiveTicket(record);
  const recordedCreated = record.liveTicketCreatedBySession ?? (recordedTicket !== null);
  if (target.root === stable.root || stable.root.startsWith(`${target.root}${sep}`)
    || !existsSync(join(target.dir, "commondir"))) throw new Error("Discard must retain its execution checkout");
  const common = readFileSync(join(target.dir, "commondir"), "utf8").trim();
  const stableCommon = existsSync(join(stable.dir, "commondir"))
    ? realpathSync(join(stable.dir, readFileSync(join(stable.dir, "commondir"), "utf8").trim())) : realpathSync(stable.dir);
  if (realpathSync(join(target.dir, common)) !== stableCommon
    || record.branch !== evidence.branch || record.operator.id !== evidence.operatorId
    || record.operator.email !== evidence.operatorEmail || (recordedTicket ?? undefined) !== evidence.liveTicket
    || recordedCreated !== evidence.liveTicketCreatedBySession) {
    throw new Error("Discard target does not match the parent's owned session evidence");
  }
  return target;
}

/** The roles that run before a vibe session exists. */
export const STARTUP_ROLES: ReadonlySet<string> = new Set(["vibe-requirements-worker", "vibe-setup-worker"]);

/** The read-only reviewers an engineer PR takeover runs with no vibe session. */
export const TAKEOVER_REVIEWERS: ReadonlySet<string> = new Set(["vibe-adversarial-reviewer", "vibe-guardrails-reviewer"]);

/** The one writer role a PR takeover may bind; every other writer role has no takeover route. */
export const TAKEOVER_WRITER = "vibe-change-worker";

/** A launch that needs a vibe session found none; the message names the sessionless route the role has, if any. */
export class MissingSessionError extends Error {
  readonly code = "NO_VIBE_SESSION";
  constructor(agentName: string) {
    super(`This worktree has no vibe session record. ${missingSessionRoute(agentName)}`);
  }
}

function missingSessionRoute(agentName: string) {
  if (TAKEOVER_REVIEWERS.has(agentName)) {
    return "For a pull request takeover, relaunch in the worktree at the PR head with mode pull-request and "
      + 'sessionless {"kind": "takeover", "evidence": {"prUrl": "<PR URL>", "headSha": "<full head SHA>"}}.';
  }
  if (agentName === TAKEOVER_WRITER) {
    return "Inside a vibe session, start one with the vibe skill. For a pull request takeover, relaunch in the worktree at the PR head with "
      + 'sessionless {"kind": "takeover", "evidence": {"prUrl": "<PR URL>", "headSha": "<full head SHA>", "sourceBranch": "<PR source branch>"}}.';
  }
  if (STARTUP_ROLES.has(agentName)) return 'Before a session exists, relaunch with sessionless {"kind": "startup"}.';
  return "This role runs only inside a vibe session; start one with the vibe skill.";
}
