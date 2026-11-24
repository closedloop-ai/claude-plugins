import { createHash } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { outcomeArtifact, requireOutcomeCapacity } from "./cloud-outcome-artifact.mjs";

/** Files required to execute the shipped outcome writer in a private directory. */
export const reporterFiles = Object.freeze([
  "captured-json.mjs",
  "github-remote.mjs",
  "cloud-outcome-artifact.mjs",
  "cloud-outcome-writer.mjs",
]);

/** The same typed outcome identity is used by the portable and checked-in reporter routes. */
export function outcomeSpec(request,lanes,key,managedHost) {
  return {
    key,
    commit: request.commit,
    repository: request.repository,
    names: lanes.map((l) => l.name),
    combined: managedHost ? [] : lanes.flatMap((lane,index)=>lane.containerPnpm?[index]:[]),
    probe: lanes.findIndex((l) => l.capabilityProbe),
    frozen: lanes.flatMap((l, i) => (l.cloudFrozen ? [i] : [])),
    artifact:outcomeArtifact(request) ? request.resultArtifact : null,
  };
}

/** The reporter's single argument: the typed outcome identity, as the writer decodes it. */
export const packedOutcomeSpec = (spec) => Buffer.from(JSON.stringify(spec)).toString("base64url");

/** What the managed host runner needs to run the same shipped reporter itself after its lanes. */
export const hostReporter = (request, lanes, key) => ({ files: [...reporterFiles], spec: packedOutcomeSpec(outcomeSpec(request, lanes, key, true)) });

function portableReporter(spec) {
  const sources = Object.fromEntries(
    reporterFiles.map((name) => [name, readFileSync(new URL(name, import.meta.url), "utf8")]),
  );
  const encoded = brotliCompressSync(Buffer.from(JSON.stringify(sources))).toString("base64url");
  const sha = createHash("sha256").update(encoded).digest("hex"),
    dir = ".git/vibe-outcomes-" + sha.slice(0, 16);
  const packed = packedOutcomeSpec(spec);
  const install =
    'const fs=require("node:fs"),h=require("node:crypto");const [dir,sha,data]=process.argv.slice(1);if(h.createHash("sha256").update(data).digest("hex")!==sha)process.exit(1);fs.mkdirSync(dir,{recursive:true,mode:448});for(const [name,body] of Object.entries(JSON.parse(require("node:zlib").brotliDecompressSync(Buffer.from(data,"base64url"))))){fs.writeFileSync(dir+"/"+name,body,{mode:384})}';
  return {install:"node -e '"+install+"' "+dir+" "+sha+" "+encoded,reporter:"node "+dir+"/cloud-outcome-writer.mjs "+packed+' "$d"'};
}

/** Install the shipped reporter into Git's private state, including application checkouts without Vibe source. */
export function outcomeInstruction(request, lanes, key, managedHost, compact = null) {
  const artifact = outcomeArtifact(request) ? request.resultArtifact : null;
  requireOutcomeCapacity(lanes, artifact);
  if (managedHost && !compact) return [
    'The machine record replaces the archival VIBE_VALIDATION_RESULT carrier. Keep the private lane JSON fields "tail" and "diagnosis" with bounded redacted output for failures. Never place these in an outcome artifact.',
    artifact
      ? "The managed runner runs the shipped reporter itself after its lanes. It publishes the typed outcomes JSON as one child commit on the authorized fresh result branch, and its last output line is the verified result pointer. Do not run a reporter yourself; report that line."
      : "The managed runner runs the shipped reporter itself after its lanes, and its last output line is the bounded machine record. Do not run a reporter yourself; keep that line in the run log by reading the runner's output.",
  ].join("\n\n");
  const reporter=compact ?? portableReporter(outcomeSpec(request,lanes,key,managedHost));
  return [
    'The machine record replaces the archival VIBE_VALIDATION_RESULT carrier. Keep the private lane JSON fields "tail" and "diagnosis" with bounded redacted output for failures. Never place these in an outcome artifact.',
    "Save both full streams outside the checkout. Use the directory printed by the managed host, or create the direct lane directory with mktemp -d /tmp/vibe-lane-results-XXXXXX. Set d to its absolute path. Do not show its contents.",
    "For each direct lane, redirect stdout and stderr into $d/<zero-based-index>.stdout and .stderr. Record the actual foreground exit in $d/<index>.json as JSON with the exact lane name and numeric exitCode (or null and notRun when it never executed). The managed host already writes these. A preflight that ran no lane can have empty channel files only alongside its recorded nonzero preflight or notRun outcome.",
    ...(reporter.install ? ["Install the shipped machine reporter:", reporter.install] : []),
    "After all foreground commands settle, invoke the reporter exactly once as its own Bash tool call. It checks the actual Git provenance and streams the private files. It emits one bounded machine record or writes the expressly authorized outcomes JSON.",
    reporter.reporter,
    ...(artifact
      ? [
          "The reporter will publish only the typed outcomes JSON, as one child commit on the explicitly authorized fresh result branch. Its tool output is the complete verified result pointer. It refuses a previously existing result branch.",
        ]
      : []),
  ].join("\n\n");
}

/**
 * How every lane runs: in the foreground, waited for, before the result. A worker that backgrounded its suites and
 * ended its turn left a run with no result line. The Bash tool itself moves a call past 10 minutes to the background
 * (session cse_0197q287ixBjhigT9MYgm8W7), and a worker that piped a lane into `tail` guessed its exit code
 * (cse_0197q289Y6sUhyfYvqqRHVAn). The condensed run log cuts an assistant message at 2,000 characters, which cut
 * off a result line that followed a long list of failing tests (cse_0197q287ixBjhigT9MYgm8W7).
 */
export const LANE_DISCIPLINE =
  "Run every lane in the foreground and wait for it to exit, however long it takes: never " +
  "background a command yourself, never hand a lane to a monitor or a later turn, and never end your turn before " +
  "every lane has an exit code or a recorded reason it has none. Capture full output in a private file outside the checkout and print a compact status under 400 characters; read that file for redacted report parts. Give each lane's Bash call the 600000 ms timeout. The Bash " +
  "tool stops waiting after 10 minutes and moves a longer command to the background itself: when it does that to a lane, " +
  "keep waiting in this turn with a foreground `until` loop that checks whether the lane has exited and ends within one Bash " +
  "call, repeated until it has, then take the exit code from that task's completion notification; never start the lane " +
  "again. Read each exit code from the command itself (`echo EXIT=$?` right after it, never after a pipe such as `| tail`) " +
  "and never infer one from the output. A lane that never finished, or whose exit code you could not read, is reported " +
  'with "exitCode": null and "notRun": the reason. Print the result line only after every lane has finished. In the private session evidence, ' +
  "list every failing test of each failed lane by name, as its runner printed it. Your " +
  "final message is the result line alone, under 1,800 characters: the run log keeps only the first 2,000 characters of a " +
  "message. Keep detailed lane evidence in its private files; do not shorten or drop tails to fit.";
