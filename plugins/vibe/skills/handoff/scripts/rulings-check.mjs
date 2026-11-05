#!/usr/bin/env node
// Every ruling made during the work reaches the ticket, with the acceptance
// criteria it amends. Rulings once lived only in chat, QA records and review
// threads, so a later audit against the written criteria reported deliberate
// changes as misses.
//
// Usage: rulings-check.mjs --ticket <ticket body .md> --record <QA record or resume log> [--record <file>]... [--criteria-before <earlier body>]
//        rulings-check.mjs --program <rulings.md> --record <orchestrator transcript or QA record> [--record <file>]...
//        rulings-check.mjs --plan <get-document JSON of a PLN> [--plan-body <its latest version text>] [--plan ...]
//        rulings-check.mjs --ruling <file with the cited ruling's words> --scope <ticket slug>[,<PRD slug>]
//        rulings-check.mjs --sequencing <candidate rulings.md> [--pr-tickets <PR-number-to-ticket JSON>]
//        rulings-check.mjs --record-sequencing <candidate ruling> --program <rulings.md>
//          --links <confirmed BLOCKS links JSON> [--pr-tickets <PR-number-to-ticket JSON>]
//
// A ruling in a record is a line `Ruling <anything>: <decision>` (the resume
// log's `- Ruling (operator): ...`, or the same line in a QA record). The
// ticket's Scope and acceptance criteria section carries each one as
// `- Ruling <date> (<who>): "<decision>"; amends: <criteria, or none>`. Prints
// {"ok","problems"} and exits 1 when a record's ruling is missing from the
// ticket or a ticket ruling names no amended criteria. With
// `--criteria-before`, every acceptance criterion of the earlier ticket body
// that the ticket no longer carries word for word needs a ticket ruling that
// amends it by its earlier id: an agent once reworded a human's "reject moves
// beyond four levels" to "display-only" to match its code.
//
// A plan with no human approver (`approverId` null; vibe sets a PLN's status
// but never its approver) is not a ruling, so each exclusion in it must cite
// a human source: a ticket AC (`<slug> AC-<n>`), a PRD, an operator ruling, or
// a plan approved by a named human. An exclusion is an item on an
// Out-of-scope, Non-goals, Excluded, Deferred, Descoped, Obsolete or Not covered line, a
// GAP line, a bullet under such a heading, or a clause saying out of scope,
// outside this scope, not covered, deferred, descoped or obsolete. An APPROVED
// or EXECUTED plan with no approver must also carry the self-approved marker
// session-plan.mjs renders. A writer once skipped
// two tickets on an uncited Out-of-scope line of a plan vibe itself had set to
// APPROVED, against a direct instruction to build them.
//
// A ruling cited to close, narrow or skip a ticket covers it only when the
// ruling names that ticket or its PRD (`--ruling` with `--scope`): rollout
// tickets were once closed DONE on a ruling about a different surface.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { criteriaStates } from "./criteria-audit.mjs";

const RECORD_RULING = /^\s*[-*]?\s*Ruling\b[^:\n]*:\s*(.+?)\s*$/gm;
const TICKET_RULING = /^\s*[-*]\s*Ruling\b[^:\n]*:\s*(.+?)\s*$/gm;
const AMENDS = /;\s*amends:\s*(\S.*)$/;
const PROGRAM_RULING = /^\s*[-*]\s*Ruling\s+(\d{4}-\d{2}-\d{2})\s+\((operator message|AskUserQuestion|ticket):\s*(\S.*?)\):\s*(\S.*)$/gm;
const SEQUENCING_RELATION = /^(.*?)\b(?:waits?\s+(?:until|on|for)|follows?|is\s+blocked\s+by)\b(.*)$/i;
const RELATION_PARTY_REFERENCE = /^\s*(?:the\s+)?(?:\b(?:ISS|FEA)-\d+\b|#\d+\b)/i;
const OBJECT_CONTEXT = /(?:;|,\s*(?:per|see|for|because|since|as)\b|\s+(?:per|see|for|because|since|as)\s+(?=(?:ISS|FEA)-\d+\b|#\d+\b))/i;
const TICKET_REFERENCE = /\b(?:ISS|FEA)-\d+\b/gi;
const PULL_REQUEST_REFERENCE = /#(\d+)\b/g;

const EXCLUSION_LABEL = /^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s*)?\**\s*(out[- ]of[- ]scope|non-?goals?|excluded|exclusions?|deferred|descoped|obsolete|not covered|GAP(?:-\d+)?)\s*\**\s*:\s*\**\s*(.*)$/i;
const EXCLUSION_HEADING = /^#{2,6}\s+(?:out[- ]of[- ]scope|non-?goals?|excluded|exclusions|deferred|descoped|obsolete|not covered|gaps?)\b/i;
const EXCLUSION_PHRASE = /\b(?:out[- ]of[- ]scope|outside (?:of )?(?:this|the) (?:\w+ )?scope|not covered|deferred|descoped|obsolete)\b/i;
const HUMAN_SOURCE = /\bPRD-\d+\b|\b[A-Z]{2,}-\d+\s+AC-?\d+\b|\bacceptance criteri(?:on|a)\b|\boperator\b|\brulings?\b|\bruled\b|\bapproved by\b/i;
const SELF_APPROVED = /^>\s*Self-approved:/m;
const NOTHING = /^(?:none|nothing|n\/a|-)\.?$/i;

/** The exclusions in a plan body that cite no human source. */
export function uncitedExclusions(body) {
  const uncited = [];
  let underHeading = false;
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      underHeading = EXCLUSION_HEADING.test(line);
      continue;
    }
    const label = EXCLUSION_LABEL.exec(line);
    let items = [];
    if (label) {
      items = /^GAP/i.test(label[1]) ? [label[2]] : splitItems(label[2]);
    } else if (underHeading && /^\s*[-*]\s+/.test(line)) {
      items = splitItems(line.replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/, ""));
    } else {
      const prose = withoutQuotedCitations(line);
      if (EXCLUSION_PHRASE.test(prose)) {
        items = prose.split(/[|;]/).filter((clause) => EXCLUSION_PHRASE.test(clause));
      }
    }
    for (const item of items.map((text) => text.trim().replace(/^\*+|\*+$/g, "").trim()).filter(Boolean)) {
      if (!NOTHING.test(item) && !HUMAN_SOURCE.test(item)) uncited.push(item);
    }
  }
  return uncited;
}

/** Remove quoted references such as test titles, while retaining operative quoted scope prose. */
function withoutQuotedCitations(line) {
  return line.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, (quoted, offset, input) => {
    if (quoted.startsWith("`")) return "";
    const before = input.slice(0, offset);
    const after = input.slice(offset + quoted.length);
    const citationNoun = /^(?:\s|[,;:()])*(?:test|case|criterion|citation|title|heading|label|message|error|command|line|comment|phrase|string|copy)\b/i;
    const citationCue = /\b(?:called|named|titled|quoted?|citation|test)\s*$/i;
    return citationNoun.test(after) || citationCue.test(before) ? "" : quoted;
  });
}

/** Items of a list line; a trailing citation clause ("..., per operator ruling") stays with its item. */
function splitItems(text) {
  const items = [];
  for (const part of text.split(/;\s*|,\s*(?:and\s+)?|\s+and\s+(?=[A-Z]{2,}-\d)/)) {
    if (items.length > 0 && /^\s*(?:\(|per\b|source\b|see\b|as ruled\b|ruled\b|approved by\b)/i.test(part)) items[items.length - 1] += `, ${part}`;
    else items.push(part);
  }
  return items;
}

/** Problems with a plan read through get-document: uncited exclusions in a plan no human approved. */
export function planProblems(doc, body = doc?.version?.content) {
  const name = doc?.slug ?? "plan";
  if (doc?.approverId) return [];
  if (typeof body !== "string" || (body === doc?.version?.content && doc?.version?.contentTruncated)) {
    return [`${name}: pass its full latest version text with --plan-body`];
  }
  const unmarked = ["APPROVED", "EXECUTED"].includes(doc?.status) && !SELF_APPROVED.test(body)
    ? [`${name} is ${doc.status} with no human approver and is not marked self-approved; publish it from session-plan.mjs, which renders the marker, or have a human approve it`]
    : [];
  return [...unmarked, ...uncitedExclusions(body).map((item) =>
    `${name} is ${doc?.status ?? "unapproved"} with no human approver, so its exclusion "${item.slice(0, 160)}" is not a ruling; cite a ticket AC, PRD or operator ruling for it, or build it or escalate it`)];
}

function normalize(text) {
  return text.replace(/["“”']/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The decisions recorded in a QA record or resume log. */
export function recordRulings(text) {
  return [...text.matchAll(RECORD_RULING)].map((match) => match[1]);
}

/** Problems between the rulings in `records` and the ticket body. */
export function rulingProblems(ticket, records) {
  const entries = [...ticket.matchAll(TICKET_RULING)].map((match) => match[1]);
  const problems = entries.filter((entry) => !AMENDS.test(entry))
    .map((entry) => `ticket ruling "${entry}" names no amended criteria; end it with "; amends: <criteria, or none>"`);
  const decisions = entries.map((entry) => normalize(entry.replace(AMENDS, "")));
  for (const ruling of records.flatMap(recordRulings)) {
    if (!decisions.some((decision) => decision.includes(normalize(ruling)))) {
      problems.push(`ruling "${ruling}" is not on the ticket; add it under Scope and acceptance criteria as - Ruling <date> (<who>): "<decision>"; amends: <criteria>`);
    }
  }
  return problems;
}

/** Criteria of `before` reworded or dropped in `ticket` that no ticket ruling amends by id. */
export function criteriaChangeProblems(before, ticket) {
  const now = new Set(criteriaStates(ticket).map((criterion) => normalize(criterion.text)));
  const amended = new Set([...ticket.matchAll(TICKET_RULING)]
    .flatMap((match) => AMENDS.exec(match[1])?.[1].match(/\bAC-\d+\b/g) ?? []));
  return criteriaStates(before)
    .filter((criterion) => !now.has(normalize(criterion.text)) && !amended.has(criterion.id))
    .map((criterion) => `${criterion.id} "${criterion.text.slice(0, 120)}" was reworded or dropped with no ticket ruling amending ${criterion.id}; restore it, or add - Ruling <date> (<who>): "<decision>"; amends: ${criterion.id} from a human source`);
}

/** Whether a ruling's words name one of the slugs it is applied to. */
export function rulingNamesScope(text, slugs) {
  return slugs.filter(Boolean).some((slug) => new RegExp(`(?:^|[^A-Za-z0-9-])${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "i").test(text));
}

/** Problems with the program-wide ruling index and the records it reconciles. */
export function programRulingProblems(program, records) {
  const entries = [...program.matchAll(PROGRAM_RULING)].map((match) => match[4]);
  const rulingLines = program.split("\n").filter((line) => /^\s*[-*]\s*Ruling\b/.test(line));
  const problems = rulingLines.length === entries.length ? [] : [
    "each program ruling must be `- Ruling YYYY-MM-DD (operator message|AskUserQuestion|ticket: <source>): <decision>`",
  ];
  const decisions = entries.map(normalize);
  for (const ruling of records.flatMap(recordRulings)) {
    if (!decisions.some((decision) => decision.includes(normalize(ruling)))) {
      problems.push(`ruling "${ruling}" is not in the program rulings index`);
    }
  }
  return problems;
}

/** BLOCKS edges required by sourced human sequencing rulings in a program index. */
export function sequencingRequirements(program, pullRequestTickets = {}) {
  const edges = [];
  const unresolved = [];
  for (const match of program.matchAll(PROGRAM_RULING)) {
    const ruling = match[4];
    const relation = ruling.match(SEQUENCING_RELATION);
    if (!relation) continue;
    // A trailing attribution such as "the deploy for ISS-7" does not make the
    // ticket the subject or object of the sequencing relation.
    if (!RELATION_PARTY_REFERENCE.test(relation[1]) && !RELATION_PARTY_REFERENCE.test(relation[2])) continue;
    const left = resolvedTicketReferences(relation[1], pullRequestTickets);
    unresolved.push(...left.unresolved.map((reference) => ({ reference, ruling })));
    const targets = left.tickets;
    if (targets.length !== 1) {
      if (left.unresolved.length === 0) unresolved.push({ reference: relation[1].trim() || "blocked ticket", ruling });
      continue;
    }
    const blocked = targets[0];
    // Stop at a contextual citation rather than treating every ticket in
    // the sentence as another object of the sequencing verb.
    const dependencyClause = relation[2].split(OBJECT_CONTEXT, 1)[0].trim();
    const right = resolvedTicketReferences(dependencyClause, pullRequestTickets);
    if (right.hasReferences) right.unresolved.push(...namedDependencyReferences(dependencyClause));
    unresolved.push(...right.unresolved.map((reference) => ({ reference, ruling })));
    const resolved = [...new Set(right.tickets)].filter((blocker) => blocker !== blocked);
    if (resolved.length === 0 && right.unresolved.length === 0) unresolved.push({ reference: dependencyClause || "blocking ticket", ruling });
    for (const blocker of resolved) edges.push({ blocker, blocked });
  }
  return {
    edges: uniqueObjects(edges, (edge) => `${edge.blocker}>${edge.blocked}`),
    unresolved: uniqueObjects(unresolved, (entry) => `${entry.reference}>${entry.ruling}`),
  };
}

function ticketReferences(text) {
  return [...text.matchAll(TICKET_REFERENCE)].map((match) => match[0].toUpperCase());
}

function resolvedTicketReferences(text, pullRequestTickets) {
  const tickets = ticketReferences(text);
  const unresolved = [];
  let hasReferences = tickets.length > 0;
  for (const pr of text.matchAll(PULL_REQUEST_REFERENCE)) {
    hasReferences = true;
    const resolved = pullRequestTickets[pr[1]] ?? pullRequestTickets[Number(pr[1])];
    if (typeof resolved === "string" && /^(?:ISS|FEA)-\d+$/i.test(resolved)) tickets.push(resolved.toUpperCase());
    else unresolved.push(`#${pr[1]}`);
  }
  return { tickets: [...new Set(tickets)], unresolved, hasReferences };
}

function namedDependencyReferences(text) {
  const remainder = text.replace(TICKET_REFERENCE, " ").replace(PULL_REQUEST_REFERENCE, " ");
  return [...remainder.matchAll(/\b(?:the\s+)?(?:[a-z][a-z0-9-]*\s+){1,3}(?:ticket|issue|pull request)\b/gi)]
    .map((match) => match[0].replace(/^(?:and|or)\s+/i, "").trim());
}

function uniqueObjects(values, keyOf) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function confirmedBlockLinks(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("--links must contain a JSON array of confirmed artifact links");
  return new Set(parsed.filter((link) => link?.linkType === "BLOCKS").map((link) => {
    const source = link.sourceSlug ?? link.source;
    const target = link.targetSlug ?? link.target;
    return `${source}>${target}`;
  }));
}

function recordSequencing(candidateFile, programFile, prTicketsFile, linksFile) {
  const candidate = readFileSync(candidateFile, "utf8").trim();
  const prTickets = prTicketsFile ? JSON.parse(readFileSync(prTicketsFile, "utf8")) : {};
  const requirements = sequencingRequirements(candidate, prTickets);
  const syntax = programRulingProblems(candidate, []);
  const links = confirmedBlockLinks(linksFile);
  const missing = requirements.edges.filter((edge) => !links.has(`${edge.blocker}>${edge.blocked}`));
  const problems = [
    ...syntax,
    ...requirements.unresolved.map((entry) => `unresolved sequencing reference ${entry.reference}`),
    ...(requirements.edges.length === 0 && requirements.unresolved.length === 0 ? ["candidate contains no sequencing dependency"] : []),
    ...missing.map((edge) => `missing confirmed BLOCKS link ${edge.blocker} -> ${edge.blocked}`),
  ];
  if (problems.length > 0) return { ok: false, ...requirements, missing, problems };
  const current = readFileSync(programFile, "utf8");
  if (!current.split("\n").includes(candidate)) {
    const next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${candidate}\n`;
    const temporary = `${programFile}.${process.pid}.tmp`;
    writeFileSync(temporary, next);
    renameSync(temporary, programFile);
  }
  return { ok: true, ...requirements, missing: [], problems: [] };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    ticket: { type: "string" }, program: { type: "string" }, record: { type: "string", multiple: true },
    plan: { type: "string", multiple: true }, "plan-body": { type: "string", multiple: true }, "criteria-before": { type: "string" },
    ruling: { type: "string" }, scope: { type: "string" }, sequencing: { type: "string" },
    "record-sequencing": { type: "string" }, "pr-tickets": { type: "string" }, links: { type: "string" },
  } });
  if (values["record-sequencing"]) {
    if (!values.program || !values.links || values.ticket || values.record?.length || values.plan?.length || values.ruling || values.scope || values.sequencing) {
      throw new Error("--record-sequencing requires --program and --links and cannot be combined with other checks");
    }
    const result = recordSequencing(values["record-sequencing"], values.program, values["pr-tickets"], values.links);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (values.links) throw new Error("--links requires --record-sequencing");
  if (values.sequencing) {
    if (values.ticket || values.program || values.record?.length || values.plan?.length || values.ruling || values.scope) {
      throw new Error("--sequencing cannot be combined with ticket, program, plan or ruling checks");
    }
    const prTickets = values["pr-tickets"] ? JSON.parse(readFileSync(values["pr-tickets"], "utf8")) : {};
    const result = sequencingRequirements(readFileSync(values.sequencing, "utf8"), prTickets);
    const ok = result.unresolved.length === 0;
    process.stdout.write(`${JSON.stringify({ ok, ...result }, null, 2)}\n`);
    return ok ? 0 : 1;
  }
  if (values["pr-tickets"]) throw new Error("--pr-tickets requires --sequencing");
  if (values.ruling || values.scope) {
    if (!values.ruling || !values.scope) throw new Error("--ruling <file> and --scope <ticket slug>[,<PRD slug>] go together");
    const slugs = values.scope.split(",").map((slug) => slug.trim()).filter(Boolean);
    const problems = rulingNamesScope(readFileSync(values.ruling, "utf8"), slugs) ? [] : [`the ruling names neither ${slugs.join(" nor ")}; a ruling about another ticket or surface does not cover this one`];
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
    return problems.length === 0 ? 0 : 1;
  }
  const plans = values.plan ?? [];
  const bodies = values["plan-body"] ?? [];
  const rulingMode = Boolean(values.ticket || values.program);
  const before = values["criteria-before"];
  if ((before && !values.ticket) || (rulingMode && ((!values.record?.length && !before) || (values.ticket && values.program))) || (!rulingMode && plans.length === 0) || bodies.length > plans.length) {
    throw new Error("Usage: rulings-check.mjs (--ticket <ticket body .md> [--criteria-before <earlier body>] | --program <rulings.md>) --record <file>... | --plan <get-document JSON> [--plan-body <text>]...");
  }
  const records = (values.record ?? []).map((file) => readFileSync(file, "utf8"));
  const problems = [];
  if (values.program) problems.push(...programRulingProblems(readFileSync(values.program, "utf8"), records));
  else if (values.ticket) problems.push(...rulingProblems(readFileSync(values.ticket, "utf8"), records));
  if (before) problems.push(...criteriaChangeProblems(readFileSync(before, "utf8"), readFileSync(values.ticket, "utf8")));
  plans.forEach((file, index) => {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    problems.push(...planProblems(doc, bodies[index] === undefined ? undefined : readFileSync(bodies[index], "utf8")));
  });
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
