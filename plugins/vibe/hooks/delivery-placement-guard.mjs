import os from "node:os";
import { deliveryPlacementProblem, deliveryRepository } from "../lib/fleet-orchestrator/scripts/delivery-placement.mjs";
import { validChat } from "../lib/fleet-orchestrator/scripts/chat-binding.mjs";
import { ticketCreateTool } from "./ticket-project-guard.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import { inVibeSession } from "./foreground-guard.mjs";

/** The tracker's issue creation tool, regardless of its separator spelling. */
export function writesIssue(event) {
  return /(?:^|__)create[-_]document$/.test(event?.tool_name ?? "") && /^(?:ISSUE|FEATURE)$/.test(event?.tool_input?.type ?? "");
}

/** Require a delivery record before a fleet or Vibe actor files an issue. */
export function issuePlacementGuard(event, home = os.homedir()) {
  if (!writesIssue(event)) return null;
  const cwd = eventCwd(event);
  if (!conversationSkill(event, home) && !inVibeSession(cwd)) return null;
  const tool = ticketCreateTool(event, home, cwd);
  const normalize = (name) => name.split("__").map((segment) => segment.replaceAll("_", "-")).join("__");
  if (typeof tool !== "string" || normalize(event.tool_name) !== normalize(tool)) return null;
  const input = event.tool_input;
  const sourceRepository = deliveryRepository(cwd);
  const repository = input.repositorySelection?.primary?.fullName ?? sourceRepository;
  const reason = deliveryPlacementProblem({ content: input.content, repository, sourceRepository, operation: "issue", chat: validChat(event.session_id) });
  return reason ? deny(`Issue creation refused: ${reason}.`) : null;
}
