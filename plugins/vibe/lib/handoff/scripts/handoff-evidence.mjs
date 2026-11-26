import path from "node:path";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";

// Match the Claude worker's existing 8 MiB trace limit; other receipts are smaller.
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

/** Bind an evidence input to its canonical path and bytes. */
function inspectEvidence(file, retain, maxBytes = MAX_EVIDENCE_BYTES) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("evidence is not a regular file");
  if (before.size > maxBytes) throw new Error(`evidence file is too large: larger than ${maxBytes} bytes`);
  const canonical = realpathSync(file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("evidence must be the same regular file");
    if (opened.size > maxBytes) throw new Error(`evidence file is too large: larger than ${maxBytes} bytes`);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const chunks = [];
    let total = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new Error(`evidence file is too large: larger than ${maxBytes} bytes`);
      hash.update(chunk.subarray(0, read));
      if (retain) chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || total !== opened.size) throw new Error("evidence changed while hashing");
    return { fingerprint: { path: canonical, sha256: hash.digest("hex") }, text: retain ? Buffer.concat(chunks, total).toString("utf8") : undefined };
  } finally { closeSync(fd); }
}

/** Fingerprint a bounded regular file without retaining its contents. */
export function evidenceFingerprint(file) {
  return inspectEvidence(file, false).fingerprint;
}

/** Read the authenticated bytes once, optionally checking an independently saved fingerprint. */
export function readEvidence(file, expected, maxBytes) {
  return expectEvidence(inspectEvidence(file, true, maxBytes), expected, file);
}

/** Refuse evidence already read from `file` when it differs from an independently saved fingerprint. */
export function expectEvidence(result, expected, file) {
  if (expected && (expected.path !== result.fingerprint.path || expected.sha256 !== result.fingerprint.sha256)) {
    throw new Error(`Evidence changed: ${file}`);
  }
  return result;
}

/** Parse a capability list from the authenticated evidence bytes and identify malformed inputs. */
export function evidenceArray(evidence) {
  let value;
  try { value = JSON.parse(evidence.text); } catch { /* Name the private input below. */ }
  if (!Array.isArray(value)) throw new Error(`${evidence.fingerprint.path}: expected one JSON array`);
  return value;
}

/** Parse a single object from the exact bytes a public receipt check fingerprints. */
export function evidenceObject(evidence) {
  let value;
  try { value = JSON.parse(evidence.text); } catch { /* diagnostic below names the file */ }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${evidence.fingerprint.path}: expected one JSON object`);
  return value;
}

/** Verify child-process inputs against the parent's manifest at the read that supplies the parser. */
export function boundEvidenceReader(manifest) {
  const expected = new Map(manifest);
  const checked = new Map();
  return file => {
    const key = path.resolve(file);
    if (!expected.has(key)) throw new Error("Missing authenticated handoff input: " + file);
    if (!checked.has(key)) checked.set(key, readEvidence(file, expected.get(key)).text);
    return checked.get(key);
  };
}
