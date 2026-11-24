import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR = /^[1-9][0-9]*$/;
const HOST = /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TERMINAL = new Set(["MERGED", "CLOSED"]);
const WRITER_RECORDS = [".json", ".remote.json", ".remote.pending", ".remote.pending.json"];
const quote = (text) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

function stat(file) {
  try { lstatSync(file); return "present"; }
  catch (error) { return error?.code === "ENOENT" ? "absent" : "unknown"; }
}

// The remote host proves both absence and lack of a live managed session using its exact state directory.
const REMOTE_CHECK = `
const fs = require("node:fs"), path = require("node:path");
const [worktree, stateDir, name] = process.argv.slice(1);
function probe(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function status() {
  if (probe(worktree)) return "present";
  if (!probe(stateDir)?.isDirectory()) return "unknown";
  if ([".remote.pending", ".remote.pending.json"].some((suffix) => probe(path.join(stateDir, name + suffix)))) return "unknown";
  const file = path.join(stateDir, name + ".json"), stat = probe(file);
  if (!stat) return "absent";
  if (!stat.isFile()) return "unknown";
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  return saved.cwd === worktree && saved.ended && typeof saved.archivedAt === "string" ? "absent" : "unknown";
}
try { console.log(status()); } catch { console.log("unknown"); }
`;

/** Execute a fixed read-only query on the configured writer host, preserving its exit status. */
export function remoteWriterRead(host, argv, timeout = 8000) {
  if (!HOST.test(host ?? "")) throw new Error("Missing writer host");
  return execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "zsh -lic " + quote(argv.map(quote).join(" "))],
    { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** An unreadable or dangling worktree is never proof that its owning copy is absent. */
export function worktreePresence(row, remoteHost, { name, remoteStateDir } = {}) {
  if (!path.isAbsolute(row.worktree ?? "") || row.worktree.includes("\n")) return "unknown";
  if (row.where !== "remote") return stat(row.worktree);
  if (!HOST.test(remoteHost ?? "") || !path.isAbsolute(remoteStateDir ?? "") || !NAME.test(name ?? "")) return "unknown";
  try {
    const read = remoteWriterRead(remoteHost, ["node", "-e", REMOTE_CHECK, row.worktree, remoteStateDir, name]);
    return ["present", "absent"].includes(read) ? read : "unknown";
  } catch { return "unknown"; }
}

/** A registered, prepared, live or unreadable session retains ownership until its recorded end and archive. */
export function activeWriterSession(dir, name, row) {
  let listed;
  try {
    const file = path.join(dir, "sessions.txt");
    if (!lstatSync(file).isFile()) return true;
    listed = readFileSync(file, "utf8").split("\n").map((line) => line.trim().split(/\s+/))
      .some(([where, writer]) => (where === "local" || where === "remote") && writer === name);
  } catch (error) { if (error?.code !== "ENOENT") return true; }
  let archived = false;
  for (const suffix of WRITER_RECORDS) {
    const file = path.join(dir, "sessions", name + suffix);
    const state = stat(file);
    if (state === "absent") continue;
    if (suffix.includes(".pending") || state !== "present") return true;
    try {
      if (!lstatSync(file).isFile()) return true;
      const record = JSON.parse(readFileSync(file, "utf8"));
      if (record.cwd !== row.worktree || !record.ended || typeof record.archivedAt !== "string") return true;
      archived = true;
    } catch { return true; }
  }
  return Boolean(listed && !archived);
}

/** Form a retirement record only when the board row, verified PR and owning worktree agree. */
export function writerRetirement({ dir, name, row, pr, at, readPull, remoteHost, remoteStateDir,
  presence = worktreePresence, active = activeWriterSession }) {
  if (!row || !NAME.test(name) || !REPO.test(row.repo ?? "") || !PR.test(String(row.pr))) return { problem: "writer needs an exact bound repository and PR" };
  if (pr !== undefined && String(row.pr) !== pr) return { problem: "requested PR differs from the writer’s bound PR" };
  if (row.retiredAt) return { record: null };
  if (active(dir, name, row)) return { problem: "active or unverified session still owns the writer" };
  if (presence(row, remoteHost, { name, remoteStateDir }) !== "absent") return { problem: "the recorded worktree exists or absence on its owning host is unverified" };
  let pull;
  try { pull = readPull(row); } catch { return { problem: "the exact PR terminal state could not be verified" }; }
  const url = `https://github.com/${row.repo}/pull/${row.pr}`;
  if (String(pull?.number) !== String(row.pr) || String(pull?.url).toLowerCase() !== url.toLowerCase() || !TERMINAL.has(pull?.state)) {
    return { problem: "the exact bound PR is not verified MERGED or CLOSED" };
  }
  if (active(dir, name, row) || presence(row, remoteHost, { name, remoteStateDir }) !== "absent") return { problem: "writer ownership changed during verification" };
  const retiredReason = `pull request ${row.pr} ${pull.state.toLowerCase()}, worktree absent, no active session`;
  return { record: { ...row, retiredAt: at, retiredReason, retiredPr: { number: Number(row.pr), repo: row.repo, state: pull.state, url }, updatedAt: at } };
}

/** Emit identities used by the watcher to ignore retired sessions and their exact bound PRs. */
export function retirementExclusions(writers) {
  const active = new Set(Object.values(writers).filter((row) => !row.retiredAt).map((row) => `${row.repo?.toLowerCase()} ${row.pr}`));
  return Object.entries(writers).flatMap(([name, row]) => {
    if (!row.retiredAt || !NAME.test(name)) return [];
    const pull = `${row.repo?.toLowerCase()} ${row.pr}`;
    return [`writer ${name}`, ...(REPO.test(row.repo ?? "") && PR.test(String(row.pr)) && !active.has(pull) ? [`pr ${pull}`] : [])];
  });
}

/** Remove exact retired identities from either side of the watcher comparison. */
export function filterRetiredSnapshot(text, writers) {
  const retired = new Set(retirementExclusions(writers));
  return text.split("\n").filter((line) => {
    const [type, key, name, subject] = line.split(" ");
    if (type === "pr" && key) return !retired.has("pr " + key.toLowerCase().replace("#", " "));
    if (type === "session") return !retired.has("writer " + name);
    if (type === "SKILL-STALE") return !retired.has("writer " + key);
    if (type !== "board") return true;
    return !retired.has("writer " + (["UNACKED-SCOPE", "SCOPE-NOT-STARTED"].includes(key) ? subject : name));
  }).join("\n");
}

if (isEntryPoint(import.meta.url)) {
  const file = process.argv[2];
  const value = readFileSync(0, "utf8");
  try {
    if (!file || path.basename(file) !== "board.json" || !lstatSync(file).isFile()) throw new Error("verified board record is required");
    const { writers } = JSON.parse(readFileSync(file, "utf8"));
    process.stdout.write(filterRetiredSnapshot(value, writers ?? {}));
  } catch { process.stdout.write(value); }
}
