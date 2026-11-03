import { isAbsolute } from "node:path";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { commitSchema, MainSyncError } from "./main-sync-contracts.js";
import { producerFailureHead, producerReadArguments } from "./main-sync-native-failure.js";

const pairArguments = [...producerReadArguments];

/** Internal knowledge, not a receipt or an independent authorization source. */
export type FirstProducerHead = { kind: "unproved" } | { kind: "match"; head: string } | { kind: "mismatch"; head: string };

/** Standalone callers retain the original native read and refusal priority. */
export function verifyProducerHead(root: string, expected: string) {
  if (git(root, ["rev-parse", "HEAD"]) !== expected) refuse();
}

/** Only the same generated-origin assessment may request this fixed completion. */
export function readProducerMetadata(root: string, expected: string) {
  let output: string | undefined;
  let first: FirstProducerHead;
  try {
    output = git(root, pairArguments);
    first = nativeFirstHead(output, expected);
  } catch (error) {
    first = failedFirstHead(error, expected);
  }
  if (first.kind === "mismatch") refuse();
  if (first.kind === "unproved") return fallbackProducerMetadata(root, expected, first);
  if (output !== undefined) {
    const delimiter = output.indexOf("\n");
    const metadata = delimiter < 0 ? "" : output.slice(delimiter + 1).trim();
    if (isAbsolute(metadata) && !metadata.includes("\0")) return metadata;
  }
  return rereadMatchingProducerMetadata(root, expected, first);
}

/** An unproved value cannot borrow the earlier assessment identity. */
export function fallbackProducerMetadata(root: string, expected: string, _first: Extract<FirstProducerHead, { kind: "unproved" }>) {
  verifyProducerHead(root, expected);
  return git(root, ["rev-parse", "--absolute-git-dir"]);
}

function rereadMatchingProducerMetadata(root: string, expected: string, _first: Extract<FirstProducerHead, { kind: "match" }>) {
  verifyProducerHead(root, expected);
  return git(root, ["rev-parse", "--absolute-git-dir"]);
}

function nativeFirstHead(output: string, expected: string): FirstProducerHead {
  const parsed = commitSchema.safeParse(output.split("\n", 1)[0]);
  if (!parsed.success) return { kind: "unproved" };
  return { kind: parsed.data === expected ? "match" : "mismatch", head: parsed.data };
}

function failedFirstHead(error: unknown, expected: string): FirstProducerHead {
  const first = producerFailureHead(error);
  if (first.kind === "unproved") return first;
  return { kind: first.head === expected ? "match" : "mismatch", head: first.head };
}

function refuse(): never {
  throw new MainSyncError("Producer input HEAD changed during inspection", "NEEDS_CHANGE");
}
