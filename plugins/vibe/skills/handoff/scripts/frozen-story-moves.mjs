// A frozen v1.0 story file the session moved to the current Storybook taxonomy or retired, authorized by an acceptance
// criterion of the session's live ticket. Without one, a frozen file changed beyond a compile-only repair blocks in the
// inventory (`v1Stories`, `retitledStories`), the diff rules (`lost-story-id`, `frozen-render`) and the frozen-render
// gate, even when the ticket asks for the move; the only alternative kept production-dead code alive for the old story.
//
// `vibe-sessions.mjs frozen-story-move --path <story file at the base> --criterion <AC-n>` records the authorization in
// the session record (`frozenStoryMoves`), refusing a criterion the live ticket does not have. Every reader resolves it
// again here, against the ticket worker's latest complete read of the live ticket (path-citations.mjs). A recorded move is
// accepted only when:
//   - the file is a frozen v1.0 story at the base, by the base's Storybook scheme;
//   - the cited criterion exists and reads exactly as recorded; neither it nor the sub-bullets nested under its box hold
//     a negation, exclusion, condition, deferral or temporal gate (hyphens read as spaces, with story file paths and
//     this story's own IDs masked);
//     and one of its clauses (split only at sentence ends and semicolons) is an affirmative instruction for this story:
//     after an optional list marker it starts with Move, Retire or Rename and then this story (its file path or one of
//     its story IDs, as path-citations.mjs requires a cited path to be named) as the verb's direct object, with nothing
//     between them but "the", "frozen", "v1.0", "story", "stories", "file" or "stories in/of/from", and after it only an
//     optional "story" or "stories" and then the clause's end, punctuation, "to", "into", "under" or "and"; or it starts
//     with the story's name and then "is moved",
//     "is retired", "moves to" or "is renamed to"; it names no other story but a destination after "to", "into" or
//     "under", which is never itself authorized; and it is not a question. A sub-bullet never authorizes;
//   - a moved file (same path or renamed, staged or not) now has a new title that is neither frozen nor unversioned.
// A deleted file is a retirement. An accepted move lifts only the frozen blocks for that file's own story IDs: a version
// bump and Version History entry stay the `storybook-release` rule's, and a reference to a lost story ID left in another
// file stays a `lost-story-id` finding. The inventory lists each accepted move with its ticket and criterion
// (`frozenStoryMoves`) on every run, with one disclosure line per story ID that the pull request body must include; the
// frozen-render gate, when it runs, also writes each one to the change log.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { STORY_FILE, storyId } from "./diff-rules.mjs";
import { citedCriteria, currentLiveTicket, fileMentionIndex, fingerprintedReader, namesFile } from "./path-citations.mjs";
import { visibleMarkdownLines } from "./criteria-list.mjs";
import { escapeRegExp } from "./source-imports.mjs";
import { isUnversionedStory, storyExportNames, storyGroupOrderPath, storybookSchemeOf, storyMetaTitle } from "./storybook-taxonomy.mjs";
import { git, sessionLiveTicket } from "../../../lib/vibe/scripts/session-record.mjs";
import { readGitInventory } from "../../../lib/vibe/scripts/git-inventory.mjs";

const MOVE_WORD = /\b(?:mov(?:e|ed|es|ing)|retir(?:e|ed|es|ing)|renam(?:e|ed|es|ing))\b/i;
const STORY_WORD = /\bstor(?:y|ies)\b/i;

// The affirmative instructions that alone can authorize a story, by ruling (team lead, 2026-11-24): a clause that
// starts, after an optional list marker, with the imperative Move, Retire or Rename, or with the story's own name and
// then "is moved", "is retired", "moves to" or "is renamed to". Anything else, a heading such as "Out of scope:" or a
// gerund such as "Moving the story ...", authorizes nothing.
const LIST_MARKER = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|AC[- ]?\d+[.):]\s*)?/;
const IMPERATIVE = /^(?:move|retire|rename)\b/i;
const PASSIVE = String.raw`[\`'"“]?\s+(?:is\s+(?:moved|retired|renamed\s+to)|moves\s+to)\b`;
// A story file path, which the deny check masks: no deny word can hide in one.
const STORY_PATH = /[\w./-]*\.stories\.[cm]?[jt]sx?\b/g;
// A story file path or story ID, so a clause that also names a second story can be refused.
const STORY_NAME = new RegExp(String.raw`${STORY_PATH.source}|\b[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*\b`, "g");
// What text ending here introduces: a move's destination, which the clause may name and which is never authorized.
const DESTINATION = /\b(?:to|into|under)\s+(?:the\s+)?[`'"“]?$/i;
// All that may stand between the verb and the story it moves, so the story is the verb's direct object: "Move the
// mock rows out of <story>" or "Retire the decorator in <story>" names something inside the file, not the story.
const BEFORE_DIRECT_OBJECT = /^\s*(?:the\s+)?(?:frozen\s+)?(?:v1(?:\.0)?\s+)?(?:stor(?:y|ies)(?:\s+files?)?(?:\s+(?:in|of|from))?\s+)?[`'"“]?$/i;
// All that may follow that story, so it is not a modifier or possessive: "Move the <story> fixtures to ..." or
// "Move <story>'s mock rows ..." names something inside the file. After an optional "story" or "stories", the clause
// ends, or punctuation, "to", "into", "under" or "and" comes next.
const AFTER_DIRECT_OBJECT = /^[`'"”]?(?:\s+(?:story|stories))?(?:\s*$|\s*[.,:;!)]|\s+(?:to|into|under|and)\b)/i;
// A criterion or nested line item: its indent and its text.
const LIST_ITEM = /^(\s*)(?:[-*+] \[[ xX]\]|(?:AC[- ]?)?\d+[.):])\s+(.*)$/;

// A word or phrase that negates, excludes, conditions, defers or time-gates a move anywhere in the criterion or its
// sub-bullets, by ruling (team lead, 2026-11-24): any such token refuses, even an aside or another clause, because an
// unclear criterion authorizes nothing. It is matched with hyphens read as spaces, so "out-of-scope" and "follow up" match. It guards behind the affirmative shapes above.
const NEGATION_OR_EXCLUSION = new RegExp([
  String.raw`\b(?:not|never|no|nor|none|neither|without|cannot|avoid(?:s|ed|ing)?|except|excluding|exclude[sd]?)\b`,
  String.raw`\b(?:forbid(?:s|den)?|prohibit(?:s|ed)?|disallow(?:s|ed)?)\b`,
  String.raw`\w+n['’]t\b`,
  String.raw`\b(?:rather than|instead of|out of scope|de ?scop(?:e|ed|ing))\b`,
  String.raw`\bkeep(?:s|ing)?\b.*\b(?:frozen|unchanged|as is)\b`,
  String.raw`\b(?:stays?|remains?)\s+(?:frozen|unchanged|as is|in place)\b`,
  String.raw`\b(?:after(?:wards?)?|before(?:hand)?|prior to)\b`,
  String.raw`\b(?:if|unless|until|till|once|pending|provided|providing|assuming|when(?:ever)?|contingent|conditional(?:ly)?|depending)\b`,
  String.raw`\b(?:subject to|as long as|in case)\b`,
  String.raw`\bskip(?:s|ped|ping)?\b`,
  String.raw`\b(?:defer(?:s|red|ring|ral)?|later|follow ?up|optional(?:ly)?|non ?goals?|wait(?:s|ed|ing)?|blocked|outside)\b`,
].join("|"), "i");

/** Whether a criterion's text speaks of moving, retiring or renaming a story, which is what can authorize one. */
export function authorizesStoryMove(text) {
  return MOVE_WORD.test(text) && STORY_WORD.test(text);
}

/**
 * Whether neither `text` nor its `nested` sub-bullets hold a deny token and one of the clauses of `text`, split only at
 * sentence ends and semicolons, is an affirmative instruction to move, retire or rename the story `names` identify: the
 * story is the imperative's direct object, or the subject of one of the passive shapes; any other story it names is a
 * destination after the story; and it is not a question.
 */
function movesStoryInOneClause(text, names, nested = "") {
  // Story file paths and this story's own names are masked first, so a story named for a pending state, or its
  // destination path, never reads as a deny token. Any other ID-shaped token stays: "later--after" still refuses.
  let unnamed = `${text}\n${nested}`.replace(STORY_PATH, " ");
  for (const name of names) {
    for (let found = fileMentionIndex(unnamed, name); found >= 0; found = fileMentionIndex(unnamed, name)) {
      unnamed = `${unnamed.slice(0, found)} ${unnamed.slice(found + name.length)}`;
    }
  }
  if (NEGATION_OR_EXCLUSION.test(unnamed.replace(/[-‐‑–—]+/g, " "))) return false;
  const parts = text.split(/([.!?](?=\s|$)|;)/);
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index].replace(LIST_MARKER, "");
    if (parts[index + 1] === "?") continue;
    const at = Math.min(...names.map((name) => fileMentionIndex(clause, name)).filter((found) => found >= 0));
    if (!Number.isFinite(at)) continue;
    if ([...clause.matchAll(STORY_NAME)].some((token) => !names.includes(token[0])
      && !(token.index > at && DESTINATION.test(clause.slice(0, token.index))))) continue;
    const verb = IMPERATIVE.exec(clause);
    if (verb ? BEFORE_DIRECT_OBJECT.test(clause.slice(verb[0].length, at))
        && names.some((name) => clause.startsWith(name, at) && AFTER_DIRECT_OBJECT.test(clause.slice(at + name.length)))
      : names.some((name) => new RegExp(`^[\`'"“]?${escapeRegExp(name)}${PASSIVE}`, "i").test(clause))) return true;
  }
  return false;
}

/** The names a criterion can give one story file by: its repository path and each story ID its `base` text defines. */
export function storyNames(file, base) {
  const title = base ? storyMetaTitle(base) : null;
  return [file, ...(title ? storyExportNames(base).map((name) => storyId(title, name)) : [])];
}

/**
 * The criterion `cites` of the live ticket `ticket`, among its `criteria`, when it can authorize moving or retiring the
 * story `names` (storyNames) identify, or the reason it cannot. As for a cited path (path-citations.mjs), the criterion must name that story
 * itself: its file path or one of its story IDs, as a complete token, as the direct object of one clause's affirmative
 * move, retire or rename instruction, in a criterion whose text and `nested` sub-bullets (ticketMoveCriteria) hold no
 * negation, exclusion, condition, deferral or temporal gate.
 */
export function moveCriterion(criteria, cites, names, ticket) {
  const matching = criteria.filter((row) => row.id === cites);
  if (matching.length !== 1) return { problem: `the live ticket has no criterion ${cites}` };
  // Each refusal names the criterion as read and the story, so the person can reword the criterion.
  const read = `${ticket} ${cites} ("${matching[0].text}")`;
  if (!authorizesStoryMove(matching[0].text)) return { problem: `criterion ${read} does not authorize moving or retiring the story ${names[0]}` };
  if (!names.some((name) => namesFile(matching[0].text, name))) {
    return { problem: `criterion ${read} does not name ${names[0]} or one of its story IDs` };
  }
  if (!movesStoryInOneClause(matching[0].text, names, matching[0].nested)) {
    return { problem: `criterion ${read} does not move or retire the story ${names[0]} as the direct object of an affirmative instruction, or carries a negation, exclusion or condition, so it authorizes nothing` };
  }
  return { criterion: matching[0] };
}

/**
 * The ticket `body`'s criteria (path-citations.mjs citedCriteria), each with `nested`: the lines indented under every
 * box or numbered item whose text begins the criterion's, up to the next line at or left of that item. The reader drops
 * them, so only the deny check reads them, and a box matched by text alone can only add refusals.
 */
export function ticketMoveCriteria(body, criteria = citedCriteria(body)) {
  const lines = visibleMarkdownLines(body);
  return criteria.map((row) => {
    const nested = [];
    lines.forEach((line, index) => {
      const item = LIST_ITEM.exec(line);
      if (!item?.[2].trim() || !row.text.startsWith(item[2].trim())) return;
      for (const next of lines.slice(index + 1)) {
        if (next.trim() && next.search(/\S/) <= item[1].length) break;
        nested.push(next.trim());
      }
    });
    return { ...row, nested: nested.join("\n") };
  });
}

/** The live ticket's latest complete read for the session `record`: its slug, version and criteria; null when absent. */
export function liveTicketCriteria(worktree, record) {
  const ticket = sessionLiveTicket(record ?? {});
  if (!ticket || record.status !== "active") return null;
  try {
    const current = currentLiveTicket(worktree, ticket, fingerprintedReader([]));
    return current ? { ticket, version: current.doc.latestVersion, criteria: ticketMoveCriteria(current.body, current.criteria) } : null;
  } catch {
    // Missing, unreadable or partial private evidence authorizes nothing.
    return null;
  }
}

/**
 * The recorded `entries` resolved against `live` (liveTicketCriteria): `moves` accepted, `problems` for each refused.
 * `scheme` is the base's Storybook scheme (storybook-taxonomy.mjs); `readBase` and `readHead` read one file at the base
 * and in the worktree (undefined when absent); `movedTo` names the path a rename took a base file to.
 */
export function resolveFrozenStoryMoves({ entries, live, scheme, readBase, readHead, movedTo }) {
  const moves = [];
  const problems = [];
  for (const entry of entries) {
    const refuse = (reason) => problems.push(`frozen story move ${entry.path}: ${reason}`);
    if (!live) { refuse("no current read of the live ticket is saved, so its criterion cannot be checked"); continue; }
    if (entry.ticket !== live.ticket) { refuse(`recorded for ${entry.ticket}, but the live ticket is ${live.ticket}`); continue; }
    const cited = live.criteria.filter((row) => row.id === entry.cites);
    if (cited.length === 1 && cited[0].text !== entry.text) { refuse(`criterion ${entry.cites} changed since it was recorded; record the move again`); continue; }
    const base = readBase(entry.path);
    const { problem } = moveCriterion(live.criteria, entry.cites, storyNames(entry.path, base), live.ticket);
    if (problem) { refuse(problem); continue; }
    if (base === undefined || isUnversionedStory(base) || !(scheme.frozenTitle(base) || scheme.frozenTag(base))) {
      refuse("it is not a frozen v1.0 story at the base"); continue;
    }
    const to = movedTo(entry.path) ?? (readHead(entry.path) === undefined ? null : entry.path);
    const baseTitle = storyMetaTitle(base);
    if (to !== null) {
      const head = readHead(to) ?? "";
      const title = storyMetaTitle(head);
      if (!title || title === baseTitle || scheme.frozenTitle(head) || scheme.frozenTag(head) || isUnversionedStory(head)) {
        refuse(`${to} does not give it a new current-taxonomy title`); continue;
      }
    }
    const kind = to === null ? "retired" : "moved";
    const storyIds = storyNames(entry.path, base).slice(1);
    moves.push({ path: entry.path, ...(to !== null && to !== entry.path ? { to } : {}), kind, ticket: live.ticket, criterion: entry.cites,
      version: live.version, storyIds, disclosures: storyIds.map((id) => `Frozen story ${kind}: \`${id}\` (${live.ticket} ${entry.cites}).`) });
  }
  return { moves, problems };
}

/**
 * The session record's frozen story moves for the worktree `repo` against `base`, read from git and the worktree, as
 * the inventory and the frozen-render gate both read them.
 */
export function frozenStoryMoves(repo, base, record) {
  const entries = (Array.isArray(record?.frozenStoryMoves) ? record.frozenStoryMoves : [])
    .filter((entry) => typeof entry?.path === "string" && typeof entry.cites === "string");
  if (entries.length === 0) return { moves: [], problems: [] };
  const readBase = (file) => {
    try { return git(repo, ["show", `${base}:${file}`]); } catch { return undefined; }
  };
  const readHead = (file) => {
    const absolute = path.join(repo, file);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  };
  const renames = storyRenames(repo, base, { untracked: true });
  const order = storyGroupOrderPath();
  const scheme = storybookSchemeOf(order ? readBase(order) ?? null : null);
  return resolveFrozenStoryMoves({ entries, live: liveTicketCriteria(repo, record), scheme, readBase, readHead,
    movedTo: (file) => renames.get(file) });
}

/**
 * Each base path git sees the worktree `repo` rename since `base`, mapped to its new path; `pathspecs` narrow the
 * listing. Git sees a rename only between index entries, so with `untracked` a story file not yet staged counts too: it
 * is added as an intent-to-add entry to a copy of the index, and the worktree's own index is never written.
 */
export function storyRenames(repo, base, { pathspecs = [], untracked = false } = {}) {
  const added = untracked ? readGitInventory(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter((file) => STORY_FILE.test(file)) : [];
  const list = (env) => new Map(git(repo, ["diff", "--name-status", "-M", "--diff-filter=R", base, ...(pathspecs.length ? ["--", ...pathspecs] : [])], { env })
    .split("\n").filter(Boolean).map((line) => line.split("\t")).map(([, from, to]) => [from, to]));
  if (added.length === 0) return list(undefined);
  // The copied index lives in the worktree's own Git metadata, never the system temp folder, and is removed below.
  const scratch = mkdtempSync(path.join(git(repo, ["rev-parse", "--absolute-git-dir"]), "vibe-frozen-story-moves-"));
  try {
    const index = path.join(scratch, "index");
    const live = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (existsSync(live)) copyFileSync(live, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(repo, ["add", "--intent-to-add", "--", ...added], { env });
    return list(env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
