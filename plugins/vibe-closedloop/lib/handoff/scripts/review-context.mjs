import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";
import { ticketCriteria } from "../../../skills/handoff/scripts/criteria-list.mjs";
import { rulingNamesScope } from "../../../skills/handoff/scripts/rulings-check.mjs";
import { readSessionRecord, sessionLiveTicket } from "../../vibe/scripts/session-record.mjs";

const fence = "```review-ticket";
const supply = "Read the full ticket from the tracker by slug, then append a review-ticket block using review-context.mjs --ticket SLUG --read FILE [--rulings FILE].";
export const reviewDoctrine = "When a proposed finding contradicts a bound criterion or operator ruling, report a QUESTION. Cite the conflicting words in contradicts and ask the operator's intended behavior in question. Never prescribe a fix for that contradiction.";

/** Select human decisions that name this ticket from the program ruling index. */
function programRulings(text, read) {
  const scope = [read.slug, read.parentArtifact?.slug];
  return text.split(/\r?\n/).filter(line => /^\s*[-*]\s*Ruling\b/i.test(line)
    && !/\(orchestrator\)/i.test(line) && rulingNamesScope(line, scope));
}

/** The complete current tracker body carries criteria, their continuation paragraphs and ticket-local amendments. */
function checkBinding(binding, expectedTicket) {
  const { ticket, read, rulings, trackerRead, rulingRecord } = binding ?? {};
  const version = read?.version;
  if (typeof ticket !== "string" || !/^[\w.-]+$/.test(ticket) || read?.slug !== ticket || (expectedTicket && ticket !== expectedTicket)
      || !Number.isSafeInteger(read.latestVersion) || read.latestVersion < 1 || version?.version !== read.latestVersion
      || version.contentTruncated || typeof version.content !== "string" || !Array.isArray(rulings)
      || rulings.some(line => typeof line !== "string" || !line.trim() || /\(orchestrator\)/i.test(line))) throw new Error(supply);
  try {
    if (!path.isAbsolute(trackerRead) || !statSync(trackerRead).isFile()
        || !isDeepStrictEqual(JSON.parse(readFileSync(trackerRead, "utf8")), read)) throw new Error();
    if (rulingRecord !== null && (!path.isAbsolute(rulingRecord) || !statSync(rulingRecord).isFile())) throw new Error();
    const recorded = rulingRecord === null ? [] : programRulings(readFileSync(rulingRecord, "utf8"), read);
    if (!isDeepStrictEqual(recorded, rulings)) throw new Error();
  } catch { throw new Error(supply); }
  const section = /^(?:#{1,6}\s+(?:Scope and )?Acceptance criteria\b[^\n]*|\s*-\s*Acceptance criteria:)\s*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im.exec(version.content)?.[1];
  const checklist = ticketCriteria(version.content);
  if (!checklist.length && !section?.split("\n").some(line =>
    /^\s*(?:[-*+]\s+|(?:AC[ -]?)?\d+[.):]\s+)\S/i.test(line))) throw new Error(supply);
  const criteria = [section?.trim(), ...checklist.map(item => item.text)].filter(Boolean);
  const amended = version.content.split(/\r?\n/).filter(line => /^\s*[-*]\s*Ruling\b/i.test(line) && !/\(orchestrator\)/i.test(line));
  return { ticket, version: read.latestVersion, sha256: createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
    criteria, rulings: [...new Set([...amended, ...rulings])] };
}

/** Format a portable brief directly from the slug-keyed tracker response and the program's recorded rulings. */
export function formatReviewContext(ticket, readPath, rulingPath) {
  const trackerRead = realpathSync(readPath);
  const read = JSON.parse(readFileSync(trackerRead, "utf8"));
  const rulingRecord = rulingPath ? realpathSync(rulingPath) : null;
  const rulings = rulingRecord ? programRulings(readFileSync(rulingRecord, "utf8"), read) : [];
  const binding = { ticket, trackerRead, read, rulingRecord, rulings };
  checkBinding(binding, ticket);
  return [reviewDoctrine, fence, JSON.stringify(binding), "```"].join("\n");
}

/** Refuse an absent, ambiguous, incomplete or mismatched read before starting the helper. */
export function boundReviewContext(brief, worktree, orchDir, ticket) {
  const blocks = [...brief.matchAll(/^```review-ticket[^\S\n]*\n([^\n]+)\r?\n```[^\S\n]*$/gm)];
  let binding;
  if (blocks.length === 1) {
    try { binding = JSON.parse(blocks[0][1]); } catch { /* Use the same actionable refusal for damaged JSON. */ }
  }
  if (!binding) throw new Error(supply);
  const present = sessionLiveTicket(readSessionRecord(worktree) ?? {});
  const source = checkBinding(binding, ticket ?? present);
  if (present && present !== source.ticket) throw new Error(supply);
  const index = orchDir && path.join(orchDir, "rulings.md");
  if (index && existsSync(index) && programRulings(readFileSync(index, "utf8"), binding.read)
      .some(line => !binding.rulings.includes(line) && !binding.read.version.content.includes(line))) throw new Error(supply);
  return source;
}

/** Move findings that contradict a bound criterion or ruling into the review's questions. */
export function reviewQuestions(result, binding) {
  if (!Array.isArray(result?.findings)) return result;
  const conflicts = result.findings.filter(finding => finding && Object.hasOwn(finding, "contradicts"));
  if (!conflicts.length && result.questions === undefined) return result;
  if (result.questions !== undefined && !Array.isArray(result.questions)) throw new Error("Review questions must be a list.");
  const questions = [...(result.questions ?? []), ...conflicts];
  if (questions.some(item => typeof item?.contradicts !== "string" || !item.contradicts.trim()
      || typeof item.question !== "string" || !item.question.trim())) throw new Error("A contradiction needs quoted criteria or ruling evidence and a QUESTION.");
  const authority = [...(binding?.criteria ?? []), ...(binding?.rulings ?? [])];
  if (questions.some(item => !authority.some(text => text.includes(item.contradicts)))) {
    throw new Error("A QUESTION must quote the bound criterion or ruling it contradicts.");
  }
  return { ...result, findings: result.findings.filter(finding => !conflicts.includes(finding)),
    questions: questions.map(({ contradicts, question }) => ({ kind: "QUESTION", contradicts, question })) };
}

if (isEntryPoint(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { ticket: { type: "string" }, read: { type: "string" }, rulings: { type: "string" } } });
    if (!values.ticket || !values.read) throw new Error(supply);
    console.log(formatReviewContext(values.ticket, values.read, values.rulings));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
