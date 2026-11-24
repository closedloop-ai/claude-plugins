#!/usr/bin/env node
// Every ruling made during the work reaches the ticket, with the acceptance
// criteria it amends. Rulings once lived only in chat, QA records and review
// threads, so a later audit against the written criteria reported deliberate
// changes as misses.
//
// Usage: rulings-check.mjs --ticket <ticket body .md> --record <QA record or resume log> [--record <file>]... [--criteria-before <earlier body>]
//        rulings-check.mjs --program <rulings.md> --record <orchestrator transcript or QA record> [--record <file>]...
//        rulings-check.mjs --plan <the tracker's plan document JSON> [--plan-body <its latest version text>] [--plan ...]
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
// A plan with no human approver (`approverId` null; vibe sets a plan document's status
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
import { parseArgs } from "node:util";
import { issueKey, requirementsKey, trackerKey } from "../../vibe/scripts/tracker-key.mjs";
import { criteriaStates, visibleMarkdownLines } from "./criteria-list.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const { failScript } = await vibeCore("lib/vibe/scripts/provider.mjs");

const RECORD_RULING = /^\s*[-*]?\s*Ruling\b(?:[^:\n]*\([^\n)]*\)|[^:\n]*):\s*(.+?)\s*$/gm;
const TICKET_RULING = /^\s*[-*]\s*Ruling\b(?:[^:\n]*\([^\n)]*\)|[^:\n]*):\s*(.+?)\s*$/gm;
const AMENDS = /;\s*amends:\s*(\S.*)$/;
const PROGRAM_RULING = /^\s*[-*]\s*Ruling\s+(\d{4}-\d{2}-\d{2})\s+\((operator message|AskUserQuestion|ticket):\s*(\S.*?)\):\s*(\S.*)$/gm;
const SEQUENCING_RELATION = /^(.*?)\b(?:waits?\s+(?:until|on|for)|follows?|is\s+blocked\s+by)\b(.*)$/i;
// The bound tracker's issue key (tracker-key.mjs); these checks run only with a tracker bound.
const relationPartyReference = () => new RegExp(String.raw`^\s*(?:the\s+)?(?:\b${issueKey()}\b|#\d+\b)`, "i");
const objectContext = () => new RegExp(String.raw`(?:;|,\s*(?:per|see|for|because|since|as)\b|\s+(?:per|see|for|because|since|as)\s+(?=${issueKey()}\b|#\d+\b))`, "i");
const ticketReference = () => new RegExp(String.raw`\b${issueKey()}\b`, "gi");
const PULL_REQUEST_REFERENCE = /#(\d+)\b/g;

const EXCLUSION_LABEL = /^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s*)?\**\s*(out[- ]of[- ]scope|non-?goals?|excluded|exclusions?|deferred|descoped|obsolete|not covered|GAP(?:-\d+)?)\s*\**\s*:\s*\**\s*(.*)$/i;
const EXCLUSION_HEADING = /^#{2,6}\s+(?:out[- ]of[- ]scope|non-?goals?|excluded|exclusions|deferred|descoped|obsolete|not covered|gaps?)\b/i;
const EXCLUSION_PHRASE = /\b(?:out[- ]of[- ]scope|outside (?:of )?(?:this|the) (?:\w+ )?scope|not covered|deferred|descoped|obsolete)\b/i;
const humanSource = () => new RegExp(String.raw`\b${requirementsKey()}\b|\b${trackerKey()}\s+AC-?\d+\b|\bacceptance criteri(?:on|a)\b|\boperator\b|\brulings?\b|\bruled\b|\bapproved by\b`, "i");
const SELF_APPROVED = /^>\s*Self-approved:/m;
const ENTRY_START = /^\s*(?:[-*+]|\d+[.)]|#{1,6})\s/;
const DECISION_ENTRY = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?\**Decision\b[^:\n]*:/;
const RULING_ENTRY = /^\s*(?:[-*+]\s+)?Ruling\b/;
const CRITERION_ID = /\bAC-\d+\b/;
const TRADE_LABEL = /(?:^|[\s(;,])(?:accepted\s+(?:costs?|trade-?offs?|gaps?|risks?)|deliberately\s+not\s+(?:fixed|built))(?=\s*[:)])/i;
const KNOWN_GAP_ON_CRITERION = /\bAC-\d+\b[^\n]*\bknown\s+gaps?\b|\bknown\s+gaps?\b[^\n]*\bAC-\d+\b/i;
const QUOTED = /"([^"\n]+)"|“([^”\n]+)”/g;
const INLINE_CODE_SPAN = /`[^`\n]*`/g;
const SOURCED_RULING = /^\s*[-*]?\s*Ruling\s+(?:(\d{4}-\d{2}-\d{2})\s+)?\(([^)\n]+)\):\s*(\S.*?)\s*$/gm;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const MIN_PARTIAL_QUOTE_WORDS = 3;
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
      if (!NOTHING.test(item) && !humanSource().test(item)) uncited.push(item);
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
  for (const part of text.split(new RegExp(String.raw`;\s*|,\s*(?:and\s+)?|\s+and\s+(?=${trackerKey()})`))) {
    if (items.length > 0 && /^\s*(?:\(|per\b|source\b|see\b|as ruled\b|ruled\b|approved by\b)/i.test(part)) items[items.length - 1] += `, ${part}`;
    else items.push(part);
  }
  return items;
}

/** Problems with a plan read from the tracker: uncited exclusions in a plan no human approved. */
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

// Match the terms that identify the decision, ignoring ordinary question framing.
const QUESTION_FRAMING = new Set(("a an and are as at be been being by can could did do does for from had has have how i if in into is it its may me my of on or our should that the their them then there these they this those to us was we were what when whether which who why will with would you your new fact rule satisfy satisfies count required use using change tell know please need want show happen happens").split(" "));

function decisionTerms(text) {
  return new Set((normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 1 && !QUESTION_FRAMING.has(word))
    .map(word => word.replace(/(?:ing|s)$/u, "")));
}

/** Reuse the record reader for ticket and program formats, returning the original dated operator lines. */
export function questionRulings(question, records, newFact = "") {
  const namedFact = newFact.trim().replace(/[.!?]$/, "");
  const offset = namedFact ? question.toLowerCase().indexOf(namedFact.toLowerCase()) : -1;
  const subject = offset < 0 ? question : question.slice(0, offset) + question.slice(offset + namedFact.length);
  const words = [...decisionTerms(subject)];
  const literal = normalize(subject).replace(/^[\s.,:;!?]+|[\s.,:;!?]+$/g, "");
  const matches = new Set();
  for (const record of records) {
    for (const match of record.matchAll(RECORD_RULING)) {
      const line = match[0].trim();
      if (/\(orchestrator\b/i.test(line)) continue;
      const body = match[1].replace(AMENDS, "");
      // Two terms from unrelated clauses of a long ruling do not establish the same decision.
      const related = body.split(/;|[.!?]\s/u).some(clause => {
        const terms = decisionTerms(clause);
        return terms.has(words[0]) && words.filter(word => terms.has(word)).length >= Math.max(2, Math.ceil(words.length / 2));
      });
      if ((literal && normalize(body).includes(literal)) || related) {
        matches.add(line);
      }
    }
  }
  const rulings = [...matches];
  if (offset >= 0 && words.length === 0) return { allowed: false, rulings };
  if (!rulings.length) return { allowed: true, rulings };
  const factWords = decisionTerms(newFact);
  const known = decisionTerms(rulings.join("\n"));
  const uncovered = offset >= 0 && factWords.size >= 3 && [...factWords].filter(word => !known.has(word)).length >= 2;
  return { allowed: uncovered, rulings };
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

/** Locate the program's exact quoted operator decision and its ticket scope. Operational notes cannot authorize a split. */
export function separationRuling(program, reason, tickets) {
  for (const match of program.matchAll(PROGRAM_RULING)) {
    const [, date, channel, source, decision] = match;
    const quoted = /^["“]([^"”]+)["”]/u.exec(decision)?.[1] ?? decision;
    if (quoted === reason && rulingNamesScope(decision, tickets)) return { date, channel, source, decision };
  }
  return null;
}

/** Whether a ruling's attribution names an agent rather than a person. */
export function isAgentAttribution(text) {
  return /\b(?:orchestrator|reviewer|agent|worker|model|system)\b/i.test(text);
}

/** The words of every dated `Ruling` line attributed to a person, across ticket bodies and ruling records. */
export function humanRulingWords(texts) {
  const rulings = [];
  for (const text of texts.filter((value) => typeof value === "string")) {
    for (const match of visibleMarkdownLines(text).join("\n").matchAll(SOURCED_RULING)) {
      if (!(match[1] || DATE.test(match[2])) || !match[2].trim() || isAgentAttribution(match[2])) continue;
      const decision = match[3].replace(AMENDS, "");
      rulings.push({ decision: normalize(decision), quotes: quotedWords(decision) });
    }
  }
  return rulings;
}

/**
 * Body entries that settle an acceptance-criterion reading or record a trade
 * with no quoted human ruling: `{ entry, kind }`, kind `decision`, `trade` or
 * `known-gap`. `sources` are the texts whose dated human `Ruling` lines count
 * (the independent tracker read and the bound program’s rulings).
 */
export function unratifiedSettlements(body, sources = []) {
  const rulings = humanRulingWords(sources);
  const cites = (text) => quotedWords(text).some((quote) => rulings.some((ruling) => ruling.quotes.includes(quote)
    || (quote.split(" ").length >= MIN_PARTIAL_QUOTE_WORDS && ruling.decision.includes(quote))));
  const unratified = [];
  for (const entry of bodyEntries(body)) {
    if (RULING_ENTRY.test(entry)) continue;
    const prose = entry.replace(INLINE_CODE_SPAN, "");
    const trade = TRADE_LABEL.exec(prose);
    if (trade && !cites(prose.slice(trade.index))) unratified.push({ entry, kind: "trade" });
    else if (DECISION_ENTRY.test(prose) && CRITERION_ID.test(prose) && !cites(prose)) unratified.push({ entry, kind: "decision" });
    else if (KNOWN_GAP_ON_CRITERION.test(prose) && !cites(prose)) unratified.push({ entry, kind: "known-gap" });
  }
  return unratified;
}

/** One refusal per unratified settlement, phrased as the question only the person can answer. */
export function settlementProblems(body, sources = []) {
  const what = { decision: "reads an acceptance criterion", trade: "records an accepted cost or trade", "known-gap": "records a known gap against an acceptance criterion" };
  return unratifiedSettlements(body, sources).map(({ entry, kind }) =>
    `"${entry.trim().slice(0, 200)}" ${what[kind]} with no cited human ruling; an agent cannot settle it. Return NEEDS_PERSON (behavior) with this question, record the answer as - Ruling <date> (<who>): "<their words>"; amends: <criteria>, and quote those words in the entry, or remove the entry and leave the criterion open`);
}

function quotedWords(text) {
  return [...text.matchAll(QUOTED)].map((match) => normalize(match[1] ?? match[2])).filter(Boolean);
}

/** List items, headings and paragraph lines of a markdown body outside fenced code; continuation lines join their item. */
function bodyEntries(body) {
  const entries = [];
  let open = false;
  for (const line of visibleMarkdownLines(body)) {
    if (!line.trim()) {
      open = false;
      continue;
    }
    if (open && !ENTRY_START.test(line) && /^\s/.test(line)) entries[entries.length - 1] += ` ${line.trim()}`;
    else entries.push(line);
    open = true;
  }
  return entries;
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
    // A trailing attribution such as "the deploy for <ticket>" does not make the
    // ticket the subject or object of the sequencing relation.
    if (!relationPartyReference().test(relation[1]) && !relationPartyReference().test(relation[2])) continue;
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
    const dependencyClause = relation[2].split(objectContext(), 1)[0].trim();
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
  return [...text.matchAll(ticketReference())].map((match) => match[0].toUpperCase());
}

function resolvedTicketReferences(text, pullRequestTickets) {
  const tickets = ticketReferences(text);
  const unresolved = [];
  let hasReferences = tickets.length > 0;
  for (const pr of text.matchAll(PULL_REQUEST_REFERENCE)) {
    hasReferences = true;
    const resolved = pullRequestTickets[pr[1]] ?? pullRequestTickets[Number(pr[1])];
    if (typeof resolved === "string" && new RegExp(`^${issueKey()}$`, "i").test(resolved)) tickets.push(resolved.toUpperCase());
    else unresolved.push(`#${pr[1]}`);
  }
  return { tickets: [...new Set(tickets)], unresolved, hasReferences };
}

function namedDependencyReferences(text) {
  const remainder = text.replace(ticketReference(), " ").replace(PULL_REQUEST_REFERENCE, " ");
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
    throw new Error("Usage: rulings-check.mjs (--ticket <ticket body .md> [--criteria-before <earlier body>] | --program <rulings.md>) --record <file>... | --plan <plan document JSON> [--plan-body <text>]...");
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

if (isEntryPoint(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.exit(failScript(error, 2));
  }
}
