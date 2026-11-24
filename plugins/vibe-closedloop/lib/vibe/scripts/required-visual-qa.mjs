import { acceptedCriticFindings } from "./visual-critic-evidence.mjs";
import { readEvidence } from "../../handoff/scripts/handoff-evidence.mjs";
import { farEndCoveragePasses, validFarEndCoverage } from "./viewport-overflow.mjs";
// Whether a change needs a visual QA pass before its pull request opens, a writer calls it ready, or it is
// merged, and whether the findings file offered for it covers the source being published. A user-visible pull
// request was opened and reported ready to merge with no visual QA on any head while the rule requiring it was
// prose only. This is the one copy: vibe's handoff gate (whose witness binds the verdict) and fleet board, and
// vibe's PR-create and merge guards all call it.
// The UI paths are the repository's own, from its provider recipe (`recipes.areas.ui`); a repository that
// declares none needs no visual QA here, and the verdict says so.
//
// A findings file is the fleet's finding-brief.mjs format ({"head": "<full sha>", "findings": [...]}, `[]` when
// QA found nothing), plus rounds with id, head, runtime and captures. Each capture records surface, target, viewport,
// theme, covered paths and a relative PNG. Current captures cover the changed paths and touched findings need a disposition.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { crc32, inflateSync } from "node:zlib";
import { providerDataOr, sessionBinding } from "./provider.mjs";

export const VISUAL_QA_STEP = "run the repository's visual QA skill on the affected screens at this head, write its findings file "
  + "with captured rounds and give every touched-surface finding a disposition "
  + "(finding-brief.mjs --require-disposition)";

const FULL_SHA = /^[0-9a-f]{40}$/;
const RUNTIMES = new Set(["storybook", "web", "electron"]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SINGLE_VALUE = /^[^\r\n|]{1,250}$/;
const SOURCE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_.@()[\]+/-]+$/;

/** The UI path prefixes the repository `binding` names declares (`recipes.areas.ui`), or none. */
function uiPaths(binding) {
  const ui = providerDataOr(binding, "recipes", "areas", null)?.ui;
  return Array.isArray(ui) ? ui : [];
}

/** Whether the repository `binding` names declares any UI paths; without them no diff needs visual QA here. */
export function declaresUiPaths(binding) {
  return uiPaths(binding).length > 0;
}

/** { required, reason, paths } for `diffPaths` in the repository `binding` names: required when a changed file sits under one of its UI paths. */
export function visualQaRequired(binding, diffPaths) {
  const ui = uiPaths(binding);
  if (ui.length === 0) return { required: false, reason: "the repository declares no UI paths (provider recipe recipes.areas.ui)", paths: [] };
  const paths = [...new Set(diffPaths.filter((file) => ui.some((prefix) => file.startsWith(prefix))))];
  if (paths.length === 0) return { required: false, reason: "no changed file is under the repository's UI paths", paths };
  return { required: true, reason: `${paths.length} changed file(s) under the repository's UI paths, first ${paths[0]}`, paths };
}

/** Check the PNG envelope, chunk checksums and decompressed scanline sizes before accepting a capture. */
export function completeCapturePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  const chunks = [];
  let expected = 0;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end);
    if (offset === 8 && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) return false;
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4);
      const bits = data[8], color = data[9], channels = [1, 0, 3, 1, 2, 0, 4][color];
      if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(bits) || data[10] || data[11] || data[12] > 1) return false;
      const passes = data[12] ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
      for (const [x, y, dx, dy] of passes) {
        if (width > x && height > y) expected += (1 + Math.ceil(Math.ceil((width-x)/dx)*channels*bits/8)) * Math.ceil((height-y)/dy);
      }
      if (expected > 128 * 1024 * 1024) return false;
    } else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") {
      if (length || end + 4 !== bytes.length || !chunks.length || !expected) return false;
      try { return inflateSync(Buffer.concat(chunks), { maxOutputLength: expected }).length === expected; }
      catch { return false; }
    }
    offset = end + 4;
  }
  return false;
}

/** Prove a capture is an actual PNG inside the directory that owns the findings record. */
function pngCapture(root, file) {
  if (typeof file !== "string" || !SOURCE_PATH.test(file) || !/\.png$/i.test(file)) return false;
  let fd;
  try {
    const resolved = realpathSync(path.resolve(root, file));
    if (!resolved.startsWith(root + path.sep)) return false;
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return false;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!length) return false;
      offset += length;
    }
    return completeCapturePng(bytes);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const desktopSurface = (surface) => /(?:^|[^a-z])desktop(?:[^a-z]|$)/i.test(surface);
const desktopPath = (file) => /(?:^|\/)desktop\//i.test(file);

/** Check that the rest viewport has a complete scroll census and each scroller has a distinct far-end capture. */
function overflowProblems(capture, round, root, artifacts) {
  const { overflow } = capture;
  const visible = `${overflow?.width}x${overflow?.height}`;
  if (visible !== capture.viewport || !Number.isSafeInteger(overflow?.checkedContainers)
    || overflow.checkedContainers < 1 || !Array.isArray(overflow.entries) || overflow.entries.length > overflow.checkedContainers) {
    return [`${round.id}: ${capture.target} at ${capture.viewport} needs its runtime overflow probe`];
  }
  const paths = new Set();
  return overflow.entries.flatMap((entry) => {
    const values = [entry?.scrollWidth, entry?.clientWidth, entry?.scrollHeight, entry?.clientHeight];
    const shape = typeof entry?.path === "string" && !paths.has(entry.path) && entry.path.trim().length > 0
      && values.every((value) => Number.isSafeInteger(value) && value >= 0)
      && typeof entry.horizontal === "boolean" && typeof entry.vertical === "boolean" && typeof entry.blocking === "boolean"
      && (entry.horizontal || entry.vertical)
      && (!entry.horizontal || entry.scrollWidth > entry.clientWidth)
      && (!entry.vertical || entry.scrollHeight > entry.clientHeight);
    if (!shape || artifacts.has(entry?.farEndPng) || !pngCapture(root, entry?.farEndPng)) {
      return [`${round.id}: ${capture.target} at ${visible} has incomplete or duplicate far-end scroll evidence`];
    }
    paths.add(entry.path);
    artifacts.add(entry.farEndPng);
    if (entry.horizontal && (entry.farEndCoverage !== undefined || !entry.blocking)) {
      const maxHeight = Math.min(overflow.height, entry.clientHeight);
      if (!validFarEndCoverage(entry.farEndCoverage, maxHeight)) {
        return [`${round.id}: ${capture.target} at ${visible} needs far-end foreground coverage for ${entry.path}`];
      }
      if (!farEndCoveragePasses(entry.farEndCoverage, maxHeight)) {
        const { filled, bands } = entry.farEndCoverage;
        const cause = entry.protruding?.x?.path ?? entry.path;
        return [`${round.id}: blank far-end viewport at ${capture.target} ${visible}: ${entry.path} has foreground in ${filled.length}/${bands} height bands; furthest box: ${cause}`];
      }
    }
    if ((entry.path === ":root" && entry.horizontal) || entry.blocking) {
      const cause = entry.protruding?.x?.path ?? entry.protruding?.y?.path ?? entry.path;
      return [`${round.id}: unintended overflow at ${capture.target} ${visible}: ${entry.path} (${entry.scrollWidth}/${entry.clientWidth}px); furthest box: ${cause}`];
    }
    return [];
  });
}

/** Validate the ordered evidence ledger and map current captures to every changed UI path. */
function captureProblems(record, root, current, changed, git) {
  if (!Array.isArray(record.rounds) || record.rounds.length === 0) return ["visual QA needs captured rounds"];
  const defects = [];
  const covered = new Set();
  const roundIds = new Set();
  const artifacts = new Set();
  for (const round of record.rounds) {
    if (!SINGLE_VALUE.test(round?.id ?? "") || roundIds.has(round.id) || !FULL_SHA.test(round.head ?? "")
      || !RUNTIMES.has(round.runtime) || !Array.isArray(round.captures) || round.captures.length === 0) {
      defects.push("each QA round needs a unique id, full head, runtime and at least one capture");
      continue;
    }
    roundIds.add(round.id);
    const fresh = git ? sameTree(git, round.head, current) : current.length >= 7 && round.head.startsWith(current);
    for (const capture of round.captures) {
      const desktop = desktopSurface(capture?.surface ?? "");
      const shape = typeof capture?.surface === "string" && SINGLE_VALUE.test(capture.surface)
        && typeof capture.target === "string" && SINGLE_VALUE.test(capture.target)
        && /^\d{2,5}x\d{2,5}$/.test(capture?.viewport ?? "") && /^(light|dark)$/.test(capture?.theme ?? "")
        && Array.isArray(capture?.paths) && capture.paths.length > 0 && capture.paths.every((entry) => typeof entry === "string" && SOURCE_PATH.test(entry))
        && (round.runtime === "storybook" ? !/^\//.test(capture.target) : /^\//.test(capture.target))
        && (!desktop || round.runtime === "electron");
      if (!shape || artifacts.has(capture?.png) || !pngCapture(root, capture?.png)) {
        defects.push(`${round.id}: capture needs a unique PNG, surface, story or route, viewport, theme and changed UI paths; Desktop needs Electron`);
        continue;
      }
      artifacts.add(capture.png);
      const overflow = overflowProblems(capture, round, root, artifacts);
      if (fresh) defects.push(...overflow);
      if (fresh) for (const file of capture.paths) {
        if (!desktopPath(file) || round.runtime === "electron") covered.add(file);
      }
    }
  }
  if (covered.size === 0) defects.push("no captured round covers the current head");
  if (changed === null) defects.push("the changed UI paths could not be verified against the capture ledger");
  for (const file of changed ?? []) if (!covered.has(file)) defects.push(`no current-head visual QA capture covers ${file}`);
  return defects;
}

/** Render the publishable record without local capture paths. */
export function visualQaBodySection(record) {
  const missing = record.findings.find(finding => typeof finding.summary !== "string" || !finding.summary.trim() || !/^[^\r\n]{1,250}$/u.test(finding.summary));
  if (missing) throw new Error("a published finding needs a single-line summary");
  const rounds = record.rounds.map((round) =>
    `- ${round.id} | ${round.head} | ${round.runtime} | ${round.captures.reduce((sum, capture) => sum + 1 + (capture.overflow?.entries?.length ?? 0), 0)} PNGs | ` +
    round.captures.map((capture) => `${capture.surface}, ${capture.target}, ${capture.viewport}, ${capture.theme}`).join(" / "));
  const findings = record.findings.map((finding, index) =>
    `- ${finding.id ?? `Finding ${index + 1}`}: ${finding.summary} — ${finding.disposition || "outside touched scope"}`);
  return ["## Visual QA", "", ...rounds, "", "Findings", ...findings, ...(!findings.length ? ["- None"] : [])].join("\n");
}

/**
 * Touched-surface findings that have neither a fixing commit nor a follow-up work item of the tracker `binding`
 * names (its ticket key, else a GitHub issue number). A QA pass that found nothing has nothing to dispose of and
 * passes; only a findings value that is not a list is refused.
 */
export function dispositionProblems(findings, binding = sessionBinding(null)) {
  if (!Array.isArray(findings)) return ["findings must be a list, [] when QA found nothing"];
  const workItem = new RegExp(`^(?:${providerDataOr(binding, "tickets", "keyPattern", "#\\d+")})$`);
  return findings.flatMap((finding, index) => {
    const name = finding?.id ?? `finding ${index + 1}`;
    if (typeof finding?.touchedSurface !== "boolean") return [`${name}: touchedSurface must say true or false`];
    if (!finding.touchedSurface) return [];
    const disposition = String(finding?.disposition ?? "").trim();
    const ticket = /^ticket:\s*(\S+)$/i.exec(disposition)?.[1];
    if (/^fixed:\s*[0-9a-f]{7,40}$/i.test(disposition) || (ticket && workItem.test(ticket))) return [];
    return [`${name}: a finding on a touched surface needs disposition "fixed: <sha>" or "ticket: <id>"`];
  });
}

/**
 * Why the findings file does not cover `head`, or an empty list. With `git` (a runner for the repository that
 * holds `head`), the findings head must name a commit whose tree is `head`'s; without one it must be `head`
 * itself, written in full. A board without a local tree can still read its head-only records. Any supplied
 * capture ledger is checked, and local or publication callers require their normal changed-path proof.
 */
export function visualQaFindingsProblems(file, head, git = null, binding = sessionBinding(null), coverage = null, worktree = null, expected) {
  return readVisualQaFindings(file, head, git, binding, coverage, worktree, expected).problems;
}

/** Authenticate the findings once and return the fingerprint of the bytes used for the verdict. */
export function readVisualQaFindings(file, head, git, binding, coverage, worktree, expected) {
  if (!file) return { problems: [`no visual QA findings file (pass --visual-qa <findings.json>): ${VISUAL_QA_STEP}`] };
  try {
    const { text, fingerprint } = readEvidence(file, expected ?? acceptedCriticFindings(worktree, head));
    const record = JSON.parse(text);
    const problems = parsedFindingsProblems(record, fingerprint.path, coverage?.renderSection ? record?.head : head, git, binding, coverage);
    return { fingerprint, problems, ...(problems.length ? {} : { record }) };
  } catch (error) {
    if (expected && error.code === "ENOENT") return { problems: ["the handoff gate's visual QA findings could not be verified"] };
    if (expected && error.message.startsWith("Evidence changed:")) return { problems: ["handoff visual QA findings changed since the gate"] };
    return { problems: [`visual QA findings ${file} cannot be read: ${error.message}`] };
  }
}

function parsedFindingsProblems(parsed, file, head, git, binding, coverage) {
  const qaHead = String(parsed?.head ?? "").toLowerCase();
  if (!FULL_SHA.test(qaHead)) return [`visual QA findings ${file} must name the full head it ran on`];
  const current = String(head ?? "").toLowerCase();
  const covers = git ? sameTree(git, qaHead, current) : current.length >= 7 && qaHead.startsWith(current);
  if (!covers) return [`visual QA findings ${file} ran on ${qaHead}, not the current source ${current || "(unknown)"}: ${VISUAL_QA_STEP}`];
  const problems = dispositionProblems(parsed?.findings, binding);
  const headOnly = coverage?.remoteHeadOnly === true && git === null && parsed.rounds === undefined && coverage.body === undefined;
  if (coverage && !headOnly) {
    problems.push(...captureProblems(parsed, path.dirname(file), current, coverage.paths ?? null, git));
    if (problems.length === 0 && coverage.body !== undefined) {
      const section = /^## Visual QA[ \t]*\r?\n[\s\S]*?(?=^##\s|$(?![\s\S]))/m.exec(coverage.body)?.[0];
      if (section?.trim() !== visualQaBodySection(parsed)) problems.push("the PR body needs the complete Visual QA section from the capture ledger");
    }
  }
  return problems.map((problem) => `visual QA findings ${file}: ${problem}`);
}

/** Every path changed between `base` and `head` in the repository `git` runs in, without rename pairing. */
export function changedPaths(git, base, head) {
  return git("diff", "--name-only", "--no-renames", "-z", `${base}...${head}`).split("\0").filter(Boolean);
}

function sameTree(git, left, right) {
  try { return git("rev-parse", "--verify", `${left}^{tree}`) === git("rev-parse", "--verify", `${right}^{tree}`); }
  catch { return false; }
}
