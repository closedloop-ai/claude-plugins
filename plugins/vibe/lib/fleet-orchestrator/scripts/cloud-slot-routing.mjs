import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, constants, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { capturedJson } from "../../vibe/scripts/captured-json.mjs";
import { resolveWorkDir, readConfig } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { remoteWriterRead } from "../../../skills/fleet-orchestrator/scripts/writer-retirement.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";
import { writeAtomic } from "../../vibe/scripts/owned-state.mjs";
import { isCheckCommand } from "../../vibe/scripts/cloud-check-command.mjs";
import { TERMINAL, validationCommandKey, validationReceiptName } from "../../vibe/scripts/cloud-receipts.mjs";

const LEDGER = "cloud-heavy-refusals.jsonl";
const SETUP_RECEIPT = "cloud-check.json";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OWNER = /^[a-z0-9][a-z0-9_.-]{0,99}$/i;
const SAFE_ARG = /^[\w./:@%+=,-]+$/;

const shellWord = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function gitValue(worktree, arg, remoteHost) {
  if (!worktree) return null;
  try {
    if (remoteHost !== undefined) return remoteWriterRead(remoteHost, ["git", "-C", worktree, "rev-parse", arg]);
    return execFileSync("git", ["-C", worktree, "rev-parse", arg], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

function parseFile(file) {
  try {
    if (lstatSync(file).isFile()) return JSON.parse(readFileSync(file, "utf8"));
  } catch { /* An absent or invalid receipt cannot cover a refusal. */ }
  return null;
}

function receiptHost(orchDir, row) {
  return row.where === "remote" ? readConfig(resolveWorkDir(orchDir)).REMOTE_HOST ?? null : undefined;
}

function currentHead(row, host) {
  const head = gitValue(row.worktree, "HEAD", host) ?? row.head;
  return SHA.test(head ?? "") ? head : null;
}

function laneFor(argv) {
  const command = argv.join(" ");
  const direct = command.length <= 1000 && argv.every((arg) => SAFE_ARG.test(arg) && !path.isAbsolute(arg)) && isCheckCommand(command);
  const key = validationCommandKey(direct ? command : JSON.stringify(argv));
  const name = direct ? path.basename(argv[0]).replace(/[^a-z0-9_-]/gi, "-").toLowerCase() : "workflow";
  const shell = argv.length === 3 && /^(?:sh|bash|zsh)$/.test(path.basename(argv[0])) && ["-c", "-lc"].includes(argv[1]);
  const step = shell ? argv[2] : argv.every(arg => SAFE_ARG.test(arg) && !path.isAbsolute(arg)) ? command : null;
  return { key, name: `${name}-${key.slice(0, 12)}`, direct, workflowStep: step ? validationCommandKey(step) : null };
}

/** Record a refused exact-head fleet lane and tell its owner how to submit the shared validation request. */
export function recordCloudSlotRefusal({ orchDir, owner, worktree, where, status, cloudCommand, argv, at = Date.now() }) {
  if (![4, 78].includes(status) || !["local", "remote"].includes(where) || argv.length === 0) return null;
  const lane = laneFor(argv);
  const knownOwner = OWNER.test(owner);
  const request = path.join(orchDir, "cloud-validation", `${knownOwner ? owner : "writer"}-${lane.name}.json`);
  const proof = lane.direct ? "the exact check as a named lane" : lane.workflowStep ? "the same check through its committed workflow lane" : "unresolved mapping: identify a committed workflow lane for this command";
  const line = `CLOUD-VALIDATE ${lane.name}: node ${shellWord(cloudCommand)} validate --request ${shellWord(request)}\nCloud request: Claude, exact pushed head, ${proof}.`;
  const writers = parseFile(path.join(orchDir, "board.json"))?.writers;
  const found = Object.entries(writers ?? {}).find(([name, row]) => name === owner && row.worktree === worktree)
    ?? Object.entries(writers ?? {}).find(([, row]) => row.worktree === worktree);
  if (!found || !OWNER.test(found[0])) return line;
  const head = currentHead(found[1], receiptHost(orchDir, found[1]));
  if (!head) return line;
  const event = { owner: found[0], worktree, head, where, status, lane: lane.name, key: lane.key, direct: lane.direct, workflowStep: lane.workflowStep, requestOwner: knownOwner ? owner : "writer", at };
  try {
    const file = openSync(path.join(orchDir, LEDGER), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { appendFileSync(file, `${JSON.stringify(event)}\n`); } finally { closeSync(file); }
  } catch (error) {
    return `${line}\nfleet cloud routing could not record the refusal (${error?.code ?? "write failure"})`;
  }
  return line;
}

function readRefusals(orchDir) {
  try {
    const file = path.join(orchDir, LEDGER);
    if (!lstatSync(file).isFile()) return [];
    return readFileSync(file, "utf8").split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && [4, 78].includes(value.status) && SHA.test(value.head ?? "") && DIGEST.test(value.key ?? "")
          && typeof value.lane === "string" && /^[a-z0-9_-]+-[0-9a-f]{12}$/.test(value.lane) ? [value] : [];
      } catch { return []; }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

// Runs on the owning host. Read only regular files for this head in its authenticated Git directory.
function receiptRows(fs, path, dir, prefix) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.startsWith(prefix)).flatMap(entry => {
    try {
      const filename = path.join(dir, entry.name);
      if (fs.lstatSync(filename).size > 1024 * 1024) return [];
      return [[entry.name, JSON.parse(fs.readFileSync(filename, "utf8"))]];
    } catch { return []; }
  });
}

function readReceiptKeys(worktree, head, host) {
  const dir = gitValue(worktree, "--absolute-git-dir", host);
  if (!dir) return new Set();
  const keys = new Set();
  const prefix = `cloud-validate-${head.slice(0, 12)}-`;
  let rows;
  try {
    rows = host === undefined ? receiptRows({ readdirSync, lstatSync, readFileSync }, path, dir, prefix)
      : capturedJson(remoteWriterRead(host, ["node", "-e",
        'process.stdout.write(JSON.stringify((' + receiptRows.toString() + ')(require("node:fs"),require("node:path"),...process.argv.slice(1))))', dir, prefix]));
  } catch { return keys; }
  for (const [name, data] of rows) {
    if (!data?.taskId || typeof data.status !== "string" || !data.status || data.commit !== head
      || !DIGEST.test(data.requestDigest ?? "") || validationReceiptName(head, data.requestDigest) !== name
      || (TERMINAL.has(data.status) && data.status !== "completed") || !Array.isArray(data.laneKeys)) continue;
    for (const key of data.laneKeys) if (DIGEST.test(key)) keys.add(key);
    // Only a completed, successful committed recipe can attest to a shell step.
    const report = data.validationReport;
    if (data.status !== "completed" || !report?.passed || report.commit !== head || report.laneSource?.kind !== "github-workflow"
      || report.laneSource.commit !== head || !DIGEST.test(report.laneSource.sha256 ?? "") || !Array.isArray(report.lanes)) continue;
    for (const lane of report.lanes) {
      if (!lane.passed || lane.exitCode !== 0 || typeof lane.command !== "string" || !data.laneKeys.includes(validationCommandKey(lane.command))) continue;
      let recipe;
      try { recipe = JSON.parse(lane.command); } catch { continue; }
      if (recipe?.version !== 1 || !Array.isArray(recipe.job?.steps)) continue;
      for (const step of recipe.job.steps) {
        if (typeof step.run === "string" && !step.if && !step["continue-on-error"]) keys.add(data.requestDigest + ":" + validationCommandKey(step.run.trim()));
      }
    }
  }
  return keys;
}

function unfinishedRefusals(orchDir, writers) {
  const refusals = readRefusals(orchDir);
  return Object.entries(writers).flatMap(([owner, row]) => {
    if (row.retiredAt || row.status?.trim().toUpperCase() === "DONE") return [];
    const relevant = refusals.filter((event) => event.owner === owner && event.worktree === row.worktree);
    if (!relevant.length) return [];
    const host = receiptHost(orchDir, row);
    const head = currentHead(row, host);
    const exact = relevant.filter((event) => event.head === head);
    if (!exact.length) return [];
    const received = readReceiptKeys(row.worktree, head, host);
    const pending = exact.filter(event => {
      if (event.direct) return !received.has(event.key);
      if (!DIGEST.test(event.workflowStep ?? "") || !OWNER.test(event.requestOwner ?? "")) return true;
      const request = parseFile(path.join(orchDir, "cloud-validation", event.requestOwner + "-" + event.lane + ".json"));
      if (!request || request.commit !== head || request.worktree !== row.worktree || request.laneSource?.kind !== "github-workflow") return true;
      return !received.has(validationCommandKey(JSON.stringify(request)) + ":" + event.workflowStep);
    });
    return pending.length > 0 ? [{ owner, head, count: exact.length, pending }] : [];
  });
}

/** Persist the active program's latest setup verdict without credentials or remote tool output. */
export function recordCloudCheck(orchDir, result, at = Date.now()) {
  writeAtomic(path.join(orchDir, SETUP_RECEIPT), { ok: result.ok === true, at }, { createParent: false });
}

/** Share the exact pending refusal and receipt signal across board status and the watcher. */
export function cloudCapacityLines(orchDir, writers, { now = Date.now(), staleSeconds = 30 * 60 } = {}) {
  const groups = unfinishedRefusals(orchDir, writers);
  const missing = groups.filter(({ count }) => count >= 2).map(({ owner, head, pending }) =>
    `CLOUD-VALIDATE-MISSING ${owner} ${head.slice(0, 12)}: ${pending.length} heavy refusals without matching validation receipts (${[...new Set(pending.map(({ lane }) => lane))].join(", ")})`);
  const probe = parseFile(path.join(orchDir, SETUP_RECEIPT));
  const fresh = (at) => Number.isFinite(at) && at <= now && now - at <= staleSeconds * 1000;
  const idle = probe?.ok === true && fresh(probe.at) ? groups.filter(({ pending }) => pending.some(({ status, at }) => status === 4 && fresh(at))).map(({ owner, head }) =>
    `CLOUD-IDLE ${owner} ${head.slice(0, 12)}: heavy slots refused load and the Claude cloud check passes`) : [];
  return { missing, idle };
}

/** Repeated current-writer refusals remain visible until their exact-head validation receipts exist. */
export function missingCloudValidation(orchDir, writers) {
  return cloudCapacityLines(orchDir, writers).missing;
}

if (isEntryPoint(import.meta.url)) {
  const [orchDir, owner, worktree, where, status, cloudCommand, ...argv] = process.argv.slice(2);
  try {
    const line = recordCloudSlotRefusal({ orchDir, owner, worktree, where, status: Number(status), cloudCommand, argv });
    if (line) process.stderr.write(`${line}\n`);
  } catch (error) {
    process.stderr.write(`fleet cloud routing could not record the refusal (${error?.code ?? "read failure"})\n`);
    process.exitCode = 1;
  }
}
