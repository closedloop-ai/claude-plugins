import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquire, release } from "./e2e-lock.mjs";

const RESULT_MARKER = "VIBE_VALIDATION_RESULT";
const LANE_MARKER = "VIBE_VALIDATION_LANE";
const CHUNK_BYTES = 150; // One encoded part with its identity fits a 400-character tool preview.
const ARCHIVED_CHUNK_BYTES = 700;
// The service folds messages onto one line and retains at most 2,000 characters per message.
const RESULT_LINE = /VIBE_VALIDATION_RESULT (\{.*\})\s*$/gm;
const LANE_LINE = /VIBE_VALIDATION_LANE (\{.*\})\s*$/gm;
const CUT_RESULT_LINE = /VIBE_VALIDATION_RESULT \{[^\n]*… \[\+\d+ chars\]\s*$/m;

/** The validation worker emits indexed UTF-8 lane parts and one compact final record. */
export function validationReportInstruction(artifact) {
  return [
    "Record one lane object per requested lane in the given order. Each object has \"name\" and \"exitCode\". For failure or an unfinished lane, include \"stdoutTail\" and \"stderrTail\" (empty when the stream was empty), \"diagnosis\", and any combined \"tail\". An unfinished lane also needs \"notRun\".",
    `After the lanes finish, UTF-8 encode each lane's JSON with Node Buffer.from(JSON.stringify(lane), "utf8"). Split those bytes into chunks of at most ${CHUNK_BYTES}, base64-encode each chunk, and emit each chunk in a separate assistant text message as one line: ${LANE_MARKER} then a space and a JSON object with "commit" (the validated commit), "index" (zero-based lane position), "part" (zero-based chunk position), "parts" (chunk count for that lane) and "data" (base64 for that chunk). Include every chunk exactly once.`,
    `Your final message ends with one line: ${RESULT_MARKER} then a space and a JSON object with "commit" (the validated commit, before any result commit), "provenance" ({"host", "remote", "origin", "commit"}, each the exact output value from its line of the provenance command), "laneCount" (the number of requested lanes), and "status" (the final git status --porcelain lines, an empty list when there are none)${artifact ? `, plus "artifact" ({"path":"${artifact.path}","branch":"${artifact.branch}","commit":"<full result commit>","sha256":"<full file SHA-256>"})` : ""}.`,
  ].join("\n\n");
}

function jsonRecord(raw, label) {
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch { /* The shared diagnostic also covers valid JSON of the wrong type. */ }
  throw new Error(`cloud validation ${label} is not a JSON object`);
}

/** Read the compact final record, including the archived single-message format. */
export function validationReportSummary(log) {
  const lines = [...String(log ?? "").matchAll(RESULT_LINE)];
  if (lines.length === 0 && CUT_RESULT_LINE.test(String(log ?? ""))) throw new Error("cloud validation result line was cut off in the run log, which keeps 2,000 characters of a message; result refused");
  if (lines.length === 0) throw new Error("cloud validation returned no result line");
  return jsonRecord(lines.at(-1)[1], "result line");
}

function lanePart(raw, commit, count) {
  const entry = jsonRecord(raw, "lane record");
  if (entry.commit !== commit) throw new Error("cloud validation lane record belongs to another commit; result refused");
  if (!Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= count
    || !Number.isSafeInteger(entry.parts) || entry.parts < 1
    || !Number.isSafeInteger(entry.part) || entry.part < 0 || entry.part >= entry.parts
    || typeof entry.data !== "string" || entry.data.length > 4 * Math.ceil(ARCHIVED_CHUNK_BYTES / 3)) {
    throw new Error("cloud validation lane record has an invalid index, part count or payload; result refused");
  }
  const bytes = Buffer.from(entry.data, "base64");
  if (bytes.length === 0 || bytes.length > ARCHIVED_CHUNK_BYTES || bytes.toString("base64") !== entry.data) {
    throw new Error("cloud validation lane record has an invalid base64 payload; result refused");
  }
  return { ...entry, bytes };
}

/** Rebuild every exact lane from the canonical run log or consume an archived inline receipt. */
export function validationReportLanes(log, summary, commit, count) {
  if (summary.laneCount === undefined) {
    if (!Array.isArray(summary.lanes) || summary.lanes.length !== count) throw new Error("cloud validation did not report every requested lane; result refused");
    return { structured: false, lanes: summary.lanes };
  }
  if (summary.lanes !== undefined || summary.laneCount !== count) throw new Error("cloud validation did not report every requested lane; result refused");
  const groups = Array.from({ length: count }, () => ({ size: null, chunks: new Map() }));
  for (const [, raw] of String(log ?? "").matchAll(LANE_LINE)) {
    const { index, part, parts, bytes } = lanePart(raw, commit, count);
    const group = groups[index];
    if ((group.size !== null && group.size !== parts) || group.chunks.has(part)) {
      throw new Error(`cloud validation lane ${index + 1} has duplicate or inconsistent parts; result refused`);
    }
    group.size = parts;
    group.chunks.set(part, bytes);
  }
  const lanes = groups.map(({ size, chunks }, index) => {
    if (size === null || chunks.size !== size) throw new Error(`cloud validation lane ${index + 1} is missing or incomplete; result refused`);
    const buffers = Array.from({ length: size }, (_, part) => chunks.get(part));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers));
    return jsonRecord(decoded, `lane ${index + 1}`);
  });
  return { structured: true, lanes };
}


/** Retain only the exact session-private filenames and byte receipts for this lane. */
export function privateStreamEvidence(record, index, required = false) {
  if (record === undefined && !required) return {};
  const privateStreams = {};
  let directory;
  for (const channel of ["stdout","stderr"]) {
    const stream = record?.[channel];
    const match = typeof stream?.file === "string" && /^(\/(?:[A-Za-z0-9_.-]+\/)*vibe-lane-results-[A-Za-z0-9]+)\/(\d+)\.(stdout|stderr)$/.exec(stream.file);
    if (!match || match[1].split("/").some(part => part === ".." || part === ".") || match[2] !== String(index) || match[3] !== channel ||
        (directory && directory !== match[1]) || !Number.isSafeInteger(stream.bytes) || stream.bytes < 0 || !/^[a-f0-9]{64}$/.test(stream.sha256)) {
      throw new Error("invalid private stream receipt for validation lane " + (index+1));
    }
    directory = match[1];
    privateStreams[channel] = {file:stream.file,bytes:stream.bytes,sha256:stream.sha256};
  }
  return {privateStreams};
}

/** The host creates one result directory for all lanes of the same invocation. */
export function checkStreamDirectories(lanes) {
  const roots = new Set(lanes.filter(lane=>lane.privateStreams).map(lane=>path.dirname(lane.privateStreams.stdout.file)));
  if (roots.size > 1) throw new Error("private stream receipts belong to different validation runs");
}

/** Serialize the exact request across launch, poll and import so simultaneous retries cannot fire another run. */
export async function withValidationReportLock(file, action) {
  const lock = `${file}.lock`;
  const owner = { pid: process.pid, token: randomUUID(), purpose: "cloud-validation-request" };
  const attempt = await acquire(lock, owner, { waitSeconds: 0 });
  if (!attempt.acquired) throw new Error("CLOUD_VALIDATION_BUSY: this exact validation request is running; retry the same request to resume its receipt");
  try { return await action(); }
  finally { release(lock, owner); }
}
