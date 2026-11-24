import { createHash } from "node:crypto";
import { capturedJson } from "./captured-json.mjs";

const MARKER = "VIBE_OUTCOMES_V1 ";
const LIMIT = 400;
const HEX = /^[a-f0-9]{64}$/;
const DIRECTORY = /^\/tmp\/vibe-lane-results-([a-zA-Z0-9]{6})$/;
const CHECKS = [
  "workspace",
  "nonRoot",
  "ports",
  "chromium",
  "gitUtc",
  "controlNamespace",
  "chromium1254",
  "docker",
  "dockerBootstrap",
  "display",
  "zsh",
  "uv",
  "python313",
  "node24",
  "pnpm",
];
const DIAGNOSES = [
  "",
  "Chromium preflight failed",
  "CLOUD_PORT_RANGE_UNAVAILABLE: isolated control port pairs unavailable; run on L2",
  "a prerequisite failed",
  "lane was not run",
  "process failed; see private stream evidence",
];
const STATUS = [
  "defaultDaemon",
  "defaultHello",
  "vfsDaemon",
  "vfsHello",
  "compose",
  "electronVersion",
  "electronWindow",
];
// Fixed-width identities, actual exit and both stream sizes/digests. No free-text fields are representable.
const HEADER = 1 + 32 + 32 + 6 + 2;
const LANE = 2 + 2 * (8 + 32) + 2 + 2 + 1 + 1 + 1 + 17;
const digest = (value) => createHash("sha256").update(value).digest();
const fail = (reason) => {
  throw new Error("cloud validation outcome " + reason);
};
export const outcomeTransportBytes = (count) => MARKER.length + 4 * Math.ceil((HEADER + LANE * count) / 3);
export const logLaneCapacity = () => Math.floor((3 * Math.floor((LIMIT - MARKER.length) / 4) - HEADER) / LANE);
/**
 * Refuse before dispatch when the resolved lanes, including prerequisite lanes validate adds itself, cannot fit the
 * log. The refusal names the resolved count and the caller lanes that would fit, so the advice matches the budget.
 */
export function requireOutcomeCapacity(count, artifact, added = []) {
  if (artifact || outcomeTransportBytes(count) <= LIMIT) return;
  const capacity = logLaneCapacity(), room = capacity - added.length;
  fail(
    `would exceed the private log limit of ${LIMIT} characters before dispatch: the request resolves to ${count} lanes` +
      (added.length ? `, including ${added.length} prerequisite lane${added.length === 1 ? "" : "s"} validate adds (${added.join(", ")})` : "") +
      `, and the log holds at most ${capacity}; ` +
      (room > 0 ? `send at most ${room} caller lane${room === 1 ? "" : "s"} per request or ` : "") +
      "authorize a validation-outcomes resultArtifact",
  );
}
function streamHash(receipt) {
  if (!receipt || !HEX.test(receipt.sha256) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0)
    fail("has an invalid stream receipt");
  return Buffer.from(receipt.sha256, "hex");
}
function sets(values, keys, test) {
  if (!values) return [0, 0];
  if (Object.keys(values).some((k) => !keys.includes(k))) fail("contains an unknown measured field");
  let present = 0,
    truth = 0;
  for (const [i, key] of keys.entries())
    if (Object.hasOwn(values, key)) {
      const result = test(values[key]);
      if (result === undefined) fail("has an invalid measured value");
      present |= 1 << i;
      if (result) truth |= 1 << i;
    }
  return [present, truth];
}
/** A measured NO is valid. A successful canonical probe must have actually emitted every promised field. */
function completeProbe(checks, capabilities) {
  if (!CHECKS.every(key=>typeof checks?.[key]==="boolean") ||
      !STATUS.every(key=>capabilities?.[key]==="YES" || capabilities?.[key]==="NO")) fail("incomplete canonical capability measurements");
}

/** Read one measured marker from the canonical process output; duplicate or mismatched records cannot attest a run. */
export function observeProbeLine(evidence,line,commit) {
  const space=line.indexOf(" "), label=line.slice(0,space);
  if (label!=="CLOUD_HOST_RUNTIME" && label!=="CLOUD_CAPABILITY_STATUS") return;
  const key=label==="CLOUD_HOST_RUNTIME" ? "checks" : "capabilities";
  if (Object.hasOwn(evidence,key)) fail("duplicate canonical capability measurements");
  const record=capturedJson(line.slice(space+1));
  if (key==="checks" && record?.commit!==commit) fail("runtime commit differs");
  evidence[key]=key==="checks" ? record.checks : record;
}

/** Keep only the allowlisted measurements in a passing lane, irrespective of its selected transport. */
export function measuredProbeTranscript(text,commit) {
  const evidence={};
  for (const line of String(text ?? "").split(/\r?\n/)) observeProbeLine(evidence,line,commit);
  completeProbe(evidence.checks,evidence.capabilities);
  const fields=(keys,values)=>Object.fromEntries(keys.map(key=>[key,values[key]]));
  return "CLOUD_CAPABILITY_STATUS "+JSON.stringify(fields(STATUS,evidence.capabilities))+"\nCLOUD_HOST_RUNTIME "+
    JSON.stringify({commit,checks:fields(CHECKS,evidence.checks)});
}

export const MACHINE_OUTCOMES = "machine-v2";
/** Encode the exact approved request and machine outcomes. The caller has already checked the actual checkout, cloud marker and origin. */
export function encodeOutcomes({ key, commit, host, repository, directory, lanes, probe = -1 }) {
  if (
    !HEX.test(key) ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !host ||
    !repository ||
    !DIRECTORY.test(directory) ||
    !lanes.length ||
    lanes.length > 65535
  )
    fail("identity is incomplete");
  const bytes = Buffer.alloc(HEADER + LANE * lanes.length);
  let at = 0;
  function put(data) {
    data.copy(bytes, at);
    at += data.length;
  }
  bytes[at++] = 1;
  put(digest([key, commit, repository.toLowerCase()].join("\n")));
  put(digest(host));
  put(Buffer.from(DIRECTORY.exec(directory)[1], "ascii"));
  bytes.writeUInt16BE(lanes.length, at);
  at += 2;
  for (const [index,lane] of lanes.entries()) {
    if(index===probe && lane.exitCode===0) completeProbe(lane.checks,lane.capabilities);
    if (lane.exitCode !== null && (!Number.isInteger(lane.exitCode) || lane.exitCode < 0 || lane.exitCode > 255))
      fail("has an invalid process status");
    bytes.writeUInt16BE(lane.exitCode === null ? 256 : lane.exitCode, at);
    at += 2;
    for (const channel of ["stdout", "stderr"]) {
      const rec = lane.privateStreams?.[channel],
        hash = streamHash(rec);
      bytes.writeBigUInt64BE(BigInt(rec.bytes), at);
      at += 8;
      put(hash);
    }
    const [present, yes] = sets(lane.checks, CHECKS, (v) => (typeof v === "boolean" ? v : undefined));
    bytes.writeUInt16BE(present, at);
    at += 2;
    bytes.writeUInt16BE(yes, at);
    at += 2;
    const [observed, positive] = sets(lane.capabilities, STATUS, (v) =>
      v === "YES" ? true : v === "NO" ? false : undefined,
    );
    bytes[at++] = observed;
    bytes[at++] = positive;
    const diagnosis = DIAGNOSES.indexOf(lane.diagnosis);
    bytes[at++] = diagnosis > 0 ? diagnosis : lane.exitCode === 0 ? 0 : lane.exitCode === null ? 4 : 5;
    const frozen = lane.frozen;
    bytes[at++] = frozen?.verdict ?? 0;
    bytes.writeUInt32BE(frozen?.files ?? 0, at);
    at += 4;
    bytes.writeUInt32BE(frozen?.stories ?? 0, at);
    at += 4;
    put(Buffer.from(frozen?.inputs ?? "0000000000000000", "hex"));
  }
  return bytes.toString("base64");
}
/** Decode only fixed-width machine output. Per-session paths and lane names derive from the trusted request and a validated locator. */
export function decodeOutcomes(encoded, { key, commit, repository, names, probe, frozen = [], combined = [] }) {
  if (
    typeof encoded !== "string" ||
    !names.length ||
    names.length > 65535 ||
    encoded.length !== 4 * Math.ceil((HEADER + LANE * names.length) / 3)
  )
    fail("size differs from the request");
  const b = Buffer.from(encoded, "base64");
  if (b.length !== HEADER + LANE * names.length || b.toString("base64") !== encoded || b[0] !== 1)
    fail("format is invalid");
  let at = 1;
  const take = (n) => {
    const v = b.subarray(at, at + n);
    at += n;
    return v;
  };
  if (!take(32).equals(digest([key, commit, repository.toLowerCase()].join("\n"))))
    fail("belongs to a different request or checkout");
  const host = take(32).toString("hex");
  const directory = "/tmp/vibe-lane-results-" + take(6).toString("utf8");
  if (!DIRECTORY.test(directory) || take(2).readUInt16BE() !== names.length)
    fail("lane count or directory differs");
  const lanes = names.map((name, index) => {
    const status = take(2).readUInt16BE(),
      privateStreams = {};
    if (status > 256) fail("process status outside range");
    for (const channel of ["stdout", "stderr"]) {
      const size = Number(take(8).readBigUInt64BE()),
        sha256 = take(32).toString("hex");
      if (!Number.isSafeInteger(size)) fail("stream size outside range");
      privateStreams[channel] = { file: directory + "/" + index + "." + channel, bytes: size, sha256 };
    }
    const masks = (size, keys) => {
      const read = () => (size === 1 ? take(1)[0] : take(2).readUInt16BE());
      const present = read(),
        yes = read();
      if ((yes & ~present) !== 0 || present >> keys.length !== 0 || (present && index !== probe))
        fail("unexpected capability measurements");
      return Object.fromEntries(
        keys.flatMap((k, i) => (present & (1 << i) ? [[k, Boolean(yes & (1 << i))]] : [])),
      );
    };
    const checks = masks(2, CHECKS),
      observed = masks(1, STATUS),
      measured = Object.fromEntries(Object.entries(observed).map(([k, v]) => [k, v ? "YES" : "NO"]));
    if(index===probe && status===0) completeProbe(checks,measured);
    const diagnosis = DIAGNOSES[take(1)[0]];
    if (diagnosis === undefined) fail("contains an unknown diagnosis");
    const verdict = take(1)[0],
      files = take(4).readUInt32BE(),
      stories = take(4).readUInt32BE(),
      inputs = take(8).toString("hex");
    const verdictName = ["", "PASS", "BLOCK", "ERROR", "BUSY", "UNAVAILABLE"][verdict];
    if (
      verdictName === undefined ||
      (verdict && !frozen.includes(index)) ||
      (verdict === 1) !== (frozen.includes(index) && status === 0) ||
      (verdict !== 1 && (files !== 0 || inputs !== "0000000000000000" || (verdict !== 2 && stories !== 0)))
    )
      fail("invalid frozen verdict for requested lane");
    const frozenLine =
      verdict === 1
        ? `FROZEN PASS ${files} files ${stories} stories inputs ${inputs}`
        : verdict === 2
          ? `FROZEN BLOCK ${stories} stories`
          : verdict === 5
            ? "CLOUD_FROZEN_UNAVAILABLE"
            : verdictName
              ? "FROZEN " + verdictName
              : "";
    const stdoutTail = [
      ...(frozenLine ? [frozenLine] : []),
      ...(Object.keys(measured).length ? ["CLOUD_CAPABILITY_STATUS " + JSON.stringify(measured)] : []),
      ...(Object.keys(checks).length ? ["CLOUD_HOST_RUNTIME " + JSON.stringify({ commit, checks })] : []),
    ].join("\n");
    return {
      name,
      exitCode: status === 256 ? null : status,
      ...(status === 256 ? { notRun: "machine recorded no process exit" } : {}),
      ...(combined.includes(index) && status!==256
        ? {combinedOutput:{...privateStreams.stdout,file:directory+"/"+index+".combined"}}
        : {privateStreams}),
      stdoutTail,
      stderrTail: "",
      diagnosis,
    };
  });
  return {
    commit,
    provenance: { host: "sha256-" + host, remote: "true", origin: "https://github.com/" + repository, commit },
    status: [],
    lanes,
  };
}
export const outcomeLine = (encoded) => MARKER + encoded;

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only complete, identical machine records are usable. Repeated provider echoes may contain the same record. */
export function outcomeRecords(log, marker) {
  const pattern = new RegExp("(?<![A-Za-z0-9_])" + escaped(marker) + " ([a-zA-Z0-9+/=:.]+)", "g");
  return [...new Set([...String(log ?? "").matchAll(pattern)].map((match) => match[1]))];
}
export const ARTIFACT_MARKER = "VIBE_OUTCOME_ARTIFACT";
export function artifactPointer(log, request) {
  const all = outcomeRecords(log, ARTIFACT_MARKER),
    found = all.length === 1 && /^([0-9a-f]{40}):([0-9a-f]{64})$/.exec(all[0]);
  if (!all.length) return { path: request.resultArtifact.path, branch: request.resultArtifact.branch };
  if (!found) fail("has no unique complete result artifact pointer");
  return {
    path: request.resultArtifact.path,
    branch: request.resultArtifact.branch,
    commit: found[1],
    sha256: found[2],
  };
}
export function checkOutcomeArtifact(request) {
  if (request.resultArtifact?.kind !== undefined && !outcomeArtifact(request))
    fail("has an unsupported resultArtifact kind");
  if (!outcomeArtifact(request)) return;
  if (
    !/^\.vibe-validation-outcomes-[a-f0-9]{8,64}\.json$/.test(request.resultArtifact.path) ||
    !/^vibe-validation-results\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(request.resultArtifact.branch)
  )
    fail(
      "needs an owned vibe-validation-results/<fresh-name> branch and .vibe-validation-outcomes-<8–64 hex digits>.json path",
    );
}
export const outcomeArtifact = (request) => request.resultArtifact?.kind === "validation-outcomes";
export function readOutcomeReport(log, request, context, artifactReader) {
  let encoded, artifact;
  if (outcomeArtifact(request)) {
    artifact = artifactPointer(log, request);
    const fetched = artifactReader(request, artifact);
    const stored = fetched?.result;
    artifact = {
      ...artifact,
      commit: fetched?.commit ?? artifact.commit,
      sha256: fetched?.sha256 ?? artifact.sha256,
    };
    if (!stored || Object.keys(stored).sort().join() !== "encoded,version" || stored.version !== 1)
      fail("artifact is not an allowlisted versioned report");
    encoded = stored.encoded;
  } else {
    const records = outcomeRecords(log, MARKER.trim());
    if (!records.length) return null;
    if (records.length !== 1 || MARKER.length + records[0].length > LIMIT)
      fail("has conflicting or oversized inline evidence");
    encoded = records[0];
  }
  return { ...decodeOutcomes(encoded, context), ...(artifact ? { artifact } : {}) };
}
