// Independent sources shared by the question, live-ticket and PR gates.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionPlanEvidencePaths } from "../../vibe/scripts/session-plan.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { chatBinding, commandChat } = await vibeCore("lib/fleet-orchestrator/scripts/chat-binding.mjs");
const { readSessionRecord, sessionLiveTicket } = await vibeCore("lib/vibe/scripts/session-record.mjs");

/** Read only the program independently bound to this harness conversation. */
export function boundProgramRulings(chat = commandChat(), home = os.homedir()) {
  const binding = chatBinding(chat, { HOME: home });
  return binding ? readFileSync(path.join(binding.home, "programs", binding.program, "rulings.md"), "utf8") : null;
}

/** Return the complete latest tracker body only when the snapshot identifies the expected ticket. */
export function currentTrackerBody(snapshot, ticket) {
  const version = snapshot?.version;
  if (!snapshot?.slug || (ticket && snapshot.slug !== ticket) || !Number.isSafeInteger(snapshot.latestVersion)
      || snapshot.latestVersion < 1 || version?.version !== snapshot.latestVersion || version.contentTruncated
      || typeof version.content !== "string" || !version.content.trim()) return null;
  return version.content;
}

/** A candidate ticket, PR draft, or caller-supplied text cannot create its own settlement authority. */
export function settlementSources(worktree) {
  const sources = [boundProgramRulings()];
  if (!worktree) return sources;
  const ticket = sessionLiveTicket(readSessionRecord(worktree) ?? {});
  const file = sessionPlanEvidencePaths(worktree).liveTicketDocument;
  if (ticket && existsSync(file)) sources.push(currentTrackerBody(JSON.parse(readFileSync(file, "utf8")), ticket));
  return sources;
}
