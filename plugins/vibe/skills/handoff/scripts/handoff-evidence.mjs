import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";

// Match the Claude worker's existing 8 MiB trace limit; other receipts are smaller.
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

/** Bind an evidence input to its canonical path and bytes. */
export function evidenceFingerprint(file) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("evidence must be a regular file");
  if (before.size > MAX_EVIDENCE_BYTES) throw new Error("evidence file is too large");
  const canonical = realpathSync(file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("evidence must be the same regular file");
    if (opened.size > MAX_EVIDENCE_BYTES) throw new Error("evidence file is too large");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_EVIDENCE_BYTES) throw new Error("evidence file is too large");
      hash.update(chunk.subarray(0, read));
    }
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || total !== opened.size) throw new Error("evidence changed while hashing");
    return { path: canonical, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}
