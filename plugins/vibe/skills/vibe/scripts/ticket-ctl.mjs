#!/usr/bin/env node
// The offline, mechanical parts of `vibe-ticket-worker` (PRD-823, WS3 D9,
// ISS-13351): templating the live ticket body from structured input. It is
// ONLY those parts. The ClosedLoop REST client the plan names is blocked on an
// owner ruling about long-lived static credentials (the repository's AGENTS.md
// calls them an anti-pattern; ticket creation currently goes through the
// ClosedLoop MCP), so this file has no client, reads no token, key or
// credential from the environment or any file, and invents no auth mechanism.
// Reading and writing a ticket stays with the worker's MCP tools; this script
// transforms the body text the worker already holds.
//
// What it does, with `ticket-template.md` as the authority for every format:
//   checklist         render Engineering checklist lines from the handoff's structured entries
//                     (conflicts, forbidden paths, engineering decisions, known main failures,
//                     frozen stories, machine-limited checks, E2E left for CI, waiting criteria,
//                     tooling blockers, compile-only v1.0 repairs); same item once, idempotently
//   grading           the Grading section, copied unchanged from the template
//   replace-sections  replace named sections of a body, only those the step owns, nothing else
//   apply-record      paste `vibe-sessions.mjs ticket-sections` over Environment, Production flag
//                     snapshot and Sessions, the step the template says is never done by hand
//
// A transport (`getDocument`, `writeVersion`) can be injected into `createTicketCtl`
// for a caller that has an approved one; there is no default, so no command-line
// subcommand reads or writes a ticket. It writes no word of its own for the
// person: every sentence is a format from the template filled with the entry's
// own fields, and a missing field is an error, never a guess.
//
// Usage:
//   ticket-ctl.mjs checklist --entries-file <entries.json> [--body-file <body.md> [--out <file>]]
//   ticket-ctl.mjs grading [--template <ticket-template.md>]
//   ticket-ctl.mjs replace-sections --body-file <body.md> --sections-file <{heading: text}.json> --owner <owner> [--out <file>]
//   ticket-ctl.mjs apply-record --worktree <path> --body-file <body.md> [--out <file>]
// Owners: create, record, writer, handoff (the template's "Written by" table).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSections, TICKET_SECTIONS } from "../../handoff/scripts/live-ticket-check.mjs";
import { execCommand, parseJson } from "./ws3-exec.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(here, "..", "references", "ticket-template.md");
const SECTION_HEADING = /^## (.+?)\s*$/;

/** The sections each step may change (ticket-template.md, the "Written by" table); anything else stays exactly as it is. */
export const OWNERSHIP = Object.freeze({
  create: ["What this is", "Scope and acceptance criteria", "Engineering checklist"],
  record: ["Environment", "Production flag snapshot", "Sessions"],
  writer: ["Scope and acceptance criteria", "Progress", "Backend built", "Backend still missing"],
  handoff: ["Sessions", "Handoff", "Design Review", "Grading", "Engineering checklist"],
});

const REQUIRED_FIELDS = Object.freeze({
  conflicts: ["what", "decided", "evidence"],
  forbiddenPaths: ["area", "why"],
  decisions: ["question", "built", "evidence"],
  mainFailures: ["check", "mainSha", "evidence", "mainExit", "sessionExit"],
  frozenSame: ["storyId", "base", "reason"],
  frozenUnstable: ["storyId", "base", "diff"],
  machineLimited: ["check", "mainSha", "minutes"],
  e2eLeftForCi: ["lane", "coverage"],
  criteriaWait: ["ticket", "criterion"],
  toolingBlockers: ["what", "evidence"],
  compileOnly: ["file"],
});

// ticket-template.md, "Rules for every worker that edits it": one format per kind, in the order the rules list them.
const FORMATS = Object.freeze({
  conflicts: (e) => `- [ ] Resolve conflict: ${e.what}; decided: ${e.decided}; evidence: ${e.evidence}`,
  forbiddenPaths: (e) => `- [ ] Engineering needed (forbidden path): ${e.area}; why: ${e.why}`,
  decisions: (e) => `- [ ] Engineering decision: ${e.question}; built: ${e.built}; evidence: ${e.evidence}`,
  mainFailures: (e) => `- [ ] Known main failure: ${e.check}; fails on captured main ${e.mainSha}; evidence: ${e.evidence}; exit ${e.mainExit} on captured main, ${e.sessionExit} on the session commit`,
  frozenSame: (e) => `- [ ] Known main failure: frozen story ${e.storyId}; fails the same way on base ${e.base}; evidence: ${e.reason}`,
  frozenUnstable: (e) => `- [ ] Known main failure: frozen story ${e.storyId}; renders differently on two base renders at ${e.base}; diff: ${e.diff}`,
  machineLimited: (e) => `- [ ] Check ran out of time on this machine: ${e.check}; also on captured main ${e.mainSha}; limit ${e.minutes} min; run it on a faster machine or CI`,
  e2eLeftForCi: (e) => `- [ ] E2E left for CI: ${e.lane}; covered by ${e.coverage}; confirm it is green on the merge commit`,
  criteriaWait: (e) => `- [ ] Criterion waits on ${e.ticket}: ${e.criterion}; not met until it ships`,
  toolingBlockers: (e) => `- [ ] Vibe tooling blocker: ${e.what}; evidence: ${e.evidence}`,
  compileOnly: (e) => `- [ ] Check compile-only repair to v1.0: ${e.file}; confirm only prop, import or type changes and no visual change`,
});
// The field that makes two entries of a kind the same item ("the same path or area logged again is the same item").
const IDENTITY = Object.freeze({
  conflicts: "what", forbiddenPaths: "area", decisions: "question", mainFailures: "check", frozenSame: "storyId", frozenUnstable: "storyId",
  machineLimited: "check", e2eLeftForCi: "lane", criteriaWait: "criterion", toolingBlockers: "what", compileOnly: "file",
});

/** Wraps angle-bracketed text in a code span: ClosedLoop strips it otherwise (ticket-template.md). */
export function protectAngles(text) {
  return String(text).split(/(`[^`\n]*`)/).map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? part : part.replace(/<[^<>\n]+>/g, (match) => `\`${match}\``))).join("");
}

/** The checklist lines for `entries`, each item once, in the template's order; a missing field throws, naming it. */
export function renderChecklist(entries) {
  const lines = [];
  for (const kind of Object.keys(FORMATS)) {
    const list = entries?.[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`entries.${kind} must be a list.`);
    const seen = new Set();
    for (const [index, entry] of list.entries()) {
      for (const field of REQUIRED_FIELDS[kind]) {
        if (entry?.[field] === undefined || entry[field] === null || String(entry[field]).trim() === "") {
          throw new Error(`entries.${kind}[${index}] has no ${field}.`);
        }
      }
      const identity = String(entry[IDENTITY[kind]]).trim();
      if (seen.has(identity)) continue;
      seen.add(identity);
      lines.push(protectAngles(FORMATS[kind](Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, String(value).trim()])))));
    }
  }
  return lines;
}

/** `lines` appended to the checklist section of `body` that the section does not already hold, each exactly once. */
export function mergeChecklist(body, lines) {
  const section = parseSections(body).get("Engineering checklist");
  if (section === undefined) throw new Error("The body has no Engineering checklist section.");
  const present = new Set(section.split("\n").map((line) => line.trim()));
  const fresh = lines.filter((line) => !present.has(line.trim()));
  if (fresh.length === 0) return body;
  return replaceSections(body, { "Engineering checklist": `${section.replace(/\s+$/, "")}\n${fresh.join("\n")}\n` }, null);
}

/** The template's Grading section, copied unchanged, as `## Grading` plus its body. */
export function gradingSection(templateText) {
  const fenced = /````markdown\n([\s\S]*?)\n````/.exec(templateText)?.[1];
  if (!fenced) throw new Error("The template has no body block.");
  const grading = parseSections(fenced).get("Grading");
  if (grading === undefined) throw new Error("The template has no Grading section.");
  return `## Grading\n${grading}`;
}

/**
 * Replaces the body of each named section and nothing else: text before the
 * first heading, every other section and the order are kept byte for byte.
 * A heading the body lacks, a heading not in the ticket template, or a section
 * `owner` does not own throws; nothing is appended.
 */
export function replaceSections(body, replacements, owner) {
  const owned = owner === null ? null : OWNERSHIP[owner];
  if (owner !== null && !owned) throw new Error(`Unknown owner ${owner}; use one of ${Object.keys(OWNERSHIP).join(", ")}.`);
  const present = parseSections(body);
  for (const heading of Object.keys(replacements)) {
    if (!TICKET_SECTIONS.includes(heading)) throw new Error(`${heading} is not a section of the live ticket.`);
    if (owned && !owned.includes(heading)) throw new Error(`${heading} is not written by ${owner}; its sections are ${owned.join(", ")}.`);
    if (!present.has(heading)) throw new Error(`The body has no ${heading} section.`);
  }
  const out = [];
  let skipping = false;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const match = inFence ? null : SECTION_HEADING.exec(line);
    if (match) {
      skipping = match[1] in replacements;
      out.push(line);
      if (skipping) out.push("", ...String(replacements[match[1]]).replace(/^\n+/, "").replace(/\s+$/, "").split("\n"), "");
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/** `markdown` from `vibe-sessions.mjs ticket-sections` as `{ heading: body }` for the three record sections. */
export function recordSectionsFrom(markdown) {
  const parsed = parseSections(markdown);
  const result = {};
  for (const heading of OWNERSHIP.record) {
    const text = parsed.get(heading);
    if (text === undefined) throw new Error(`ticket-sections printed no ${heading} section.`);
    result[heading] = text;
  }
  return result;
}

/** The controller over an optional transport; with none, only the offline methods exist. */
export function createTicketCtl({ transport = null, run = execCommand } = {}) {
  function applyRecord({ worktree, body }) {
    const printed = parseJson(run(process.execPath, [path.join(here, "vibe-sessions.mjs"), "ticket-sections", "--worktree", worktree]).stdout, {});
    if (printed.ok === false || typeof printed.markdown !== "string") throw new Error(printed.error ?? "ticket-sections printed no markdown.");
    return replaceSections(body, recordSectionsFrom(printed.markdown), "record");
  }

  /** Reads the latest body through the injected transport, applies `change`, writes the whole body back. */
  async function update({ slug, change }) {
    if (!transport) throw new Error("No transport is configured: reading and writing a ticket stays with the ClosedLoop MCP until the credential ruling (ISS-13351).");
    const latest = await transport.getDocument(slug);
    const next = change(latest.body);
    if (next === latest.body) return { slug, written: false };
    await transport.writeVersion(slug, next);
    return { slug, written: true };
  }

  return { applyRecord, update };
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      "entries-file": { type: "string" }, "body-file": { type: "string" }, out: { type: "string" }, template: { type: "string" },
      "sections-file": { type: "string" }, owner: { type: "string" }, worktree: { type: "string" },
    },
  });
  const emit = (text) => {
    if (values.out) writeFileSync(values.out, text);
    process.stdout.write(text);
  };
  const body = () => {
    if (!values["body-file"]) throw new Error("--body-file is required.");
    return readFileSync(values["body-file"], "utf8");
  };
  switch (positionals[0]) {
    case "checklist": {
      if (!values["entries-file"]) throw new Error("--entries-file is required.");
      const lines = renderChecklist(JSON.parse(readFileSync(values["entries-file"], "utf8")));
      emit(values["body-file"] ? mergeChecklist(body(), lines) : `${lines.join("\n")}\n`);
      return 0;
    }
    case "grading":
      process.stdout.write(`${gradingSection(readFileSync(values.template ?? TEMPLATE, "utf8"))}\n`);
      return 0;
    case "replace-sections": {
      if (!values["sections-file"] || !values.owner) throw new Error("--sections-file and --owner are required.");
      emit(replaceSections(body(), JSON.parse(readFileSync(values["sections-file"], "utf8")), values.owner));
      return 0;
    }
    case "apply-record": {
      if (!values.worktree) throw new Error("--worktree is required.");
      emit(createTicketCtl().applyRecord({ worktree: path.resolve(values.worktree), body: body() }));
      return 0;
    }
    default:
      throw new Error("Usage: ticket-ctl.mjs checklist|grading|replace-sections|apply-record ... (no subcommand reads or writes a ticket).");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
