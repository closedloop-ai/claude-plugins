import { capturedJson } from "../lib/vibe/scripts/captured-json.mjs";
import os from "node:os";
import { readSessionRecord } from "../lib/vibe/scripts/session-record.mjs";
import { installedProviders, providerDataOr, recordedBinding } from "../lib/vibe/scripts/provider.mjs";
import { projectWriteProblem, readTicketProjectEvidence, recordTicketProjectObservation } from "../skills/vibe/scripts/ticket-project.mjs";
import { conversationSkill, hookActivated } from "./hook-session-scope.mjs";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { inVibeSession } from "./foreground-guard.mjs";

const ISSUE = /^(?:ISSUE|FEATURE)$/;

/** Resolve the exact tracker create tool even before a preflight candidate receives its persisted binding. */
export function ticketCreateTool(event, home, cwd = eventCwd(event)) {
  const binding = recordedBinding({ worktree: cwd, conversation: event.session_id ?? null, home });
  if (binding) return providerDataOr(binding, "tickets", "issueCreateTool", null);
  return installedProviders({ cwd })[0]?.contract.data?.tickets?.issueCreateTool ?? null;
}

function actionFor(event, home) {
  const tool = event?.tool_name;
  // A tracker tool is an MCP tool with its server's `__` prefix, so a call to a tool without one (Bash, Read, Edit) never
  // reads session or provider state; an MCP tool call still resolves the binding to find the tracker's prefix.
  if (typeof tool !== "string" || !tool.includes("__") || !event.session_id) return null;
  const cwd = eventCwd(event);
  if (!hookActivated(event.session_id, home) && !conversationSkill(event, home) && !inVibeSession(cwd)) return null;
  const create = ticketCreateTool(event, home, cwd);
  const prefix = typeof create === "string" ? create.slice(0, create.lastIndexOf("__") + 2) : null;
  if (!prefix || !tool.startsWith(prefix)) return null;
  const operation = tool.slice(prefix.length).replaceAll("_", "-");
  const binding = recordedBinding({ worktree: cwd, conversation: event.session_id, home });
  const tracker = binding ? providerDataOr(binding, "tickets", "projectTracker", null)
    : installedProviders({ cwd })[0]?.contract.data?.tickets?.projectTracker;
  return Object.keys(tracker?.operations ?? {}).find((key) => tracker.operations[key] === operation) ?? null;
}

function payload(value) {
  if (typeof value === "string") {
    try { return payload(capturedJson(value)); } catch { return null; }
  }
  if (Array.isArray(value) && value[0]?.type === "text") return payload(value[0].text);
  if (!value || typeof value !== "object" || value.isError === true) return null;
  return value.structuredContent ?? (value.content ? payload(value.content) : value);
}

/** Record only tracker-owned project/person/status observations for this active Vibe conversation. */
export function observeTicketProject(event, home = os.homedir()) {
  const action = actionFor(event, home);
  if (!["identity", "projects", "project", "ticket"].includes(action)) return null;
  const data = payload(event.tool_response);
  if (data) recordTicketProjectObservation(event.session_id, action, event.tool_input ?? {},
    data.project ?? data.document ?? data.user ?? data, { home });
  return null;
}

/** Enforce one saved backlog and a live work-start-only weekly move across Vibe's tracker writes. */
export function ticketProjectGuard(event, home = os.homedir()) {
  const action = actionFor(event, home);
  const input = event.tool_input ?? {};
  const create = action === "create" && ISSUE.test(input.type ?? "");
  const moves = action === "update" && Object.hasOwn(input, "projectId");
  if (!create && !moves) return null;
  const observed = readTicketProjectEvidence(event.session_id, home);
  const cwd = eventCwd(event);
  const record = inVibeSession(cwd) ? readSessionRecord(cwd) : null;
  const actor = !record?.operator?.id || observed.actor?.id === record.operator.id ? observed.actor : null;
  const reason = projectWriteProblem({ ...observed, actor, home, action: create ? "create" : "move", input,
    ticket: observed.tickets?.[String(input.documentId ?? "").toUpperCase()] });
  return reason ? deny(`Ticket project refused: ${reason}`) : null;
}
