import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { githubRepository } from "./github-remote.mjs";
import {
  checkOutcomeArtifact,
  encodeOutcomes,
  observeProbeLine,
  outcomeLine,
  requireOutcomeCapacity,
  ARTIFACT_MARKER,
} from "./cloud-outcome-artifact.mjs";

const deny = (message) => {
  throw new Error("cloud outcome writer: " + message);
};
function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    }).trim();
  } catch {
    deny("git " + args[0] + " failed; inspect the provider session privately");
  }
}
function checkedStream(file, probe, commit, frozenLane) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW),
    sum = createHash("sha256"),
    buffer = Buffer.alloc(65536);
  let bytes = 0,
    line = "",
    discard = false,
    frozen;
  const evidence={};
  function consume(final) {
    if (discard) return;
    if (frozenLane) {
      const match = /^FROZEN PASS (\d+) files (\d+) stories inputs ([0-9a-f]{16})$/.exec(final);
      const block = /^FROZEN BLOCK (\d+) stories:/.exec(final);
      const verdict = match
        ? { verdict: 1, files: Number(match[1]), stories: Number(match[2]), inputs: match[3] }
        : block
          ? { verdict: 2, stories: Number(block[1]) }
          : final.startsWith("FROZEN ERROR ")
            ? { verdict: 3 }
            : final.startsWith("FROZEN BUSY ")
              ? { verdict: 4 }
              : final.startsWith("CLOUD_FROZEN_UNAVAILABLE:")
                ? { verdict: 5 }
                : null;
      if (verdict) {
        if (frozen) deny("duplicate frozen output");
        frozen = verdict;
      }
    }
    if (probe) observeProbeLine(evidence,final,commit);
  }
  try {
    if (!fstatSync(fd).isFile()) deny("expected regular stream");
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) !== 0; ) {
      const data = buffer.subarray(0, n);
      sum.update(data);
      bytes += n;
      if (probe || frozenLane)
        for (const part of data.toString("latin1").split(/(\n)/)) {
          if (part === "\n") {
            consume(line);
            line = "";
            discard = false;
          } else if (!discard) {
            if (line.length + part.length > 4096) {
              discard = true;
              line = "";
            } else line += part;
          }
        }
    }
    if (probe || frozenLane) consume(line);
  } finally {
    closeSync(fd);
  }
  return {
    stream: { file, bytes, sha256: sum.digest("hex") },
    ...(frozen ? { frozen } : {}),
    ...evidence,
  };
}
/** Pin the pnpm wrapper's combined output with an owned hard link before hashing the actual bytes. */
export function retainedContainerStream(directory,index,status) {
  const fd=openSync(path.join(directory,index+".stdout"),constants.O_RDONLY|constants.O_NOFOLLOW);
  let summary;
  try{
    const st=fstatSync(fd);
    if(!st.isFile() || st.size>400) deny("invalid pnpm wrapper summary");
    summary=readFileSync(fd,"utf8");
  }finally{closeSync(fd)}
  const match=/^exit=(\d+) log=(\/tmp\/vibe-lane\.[A-Za-z0-9]{8}\/output\.log)\n?$/.exec(summary);
  if(!match || String(status)!==match[1]) deny("pnpm wrapper exit or private locator differs");
  const file=match[2],sourceDir=path.dirname(file),parent=lstatSync(sourceDir),source=lstatSync(file);
  if(!parent.isDirectory() || !source.isFile() || [parent,source].some(st=>st.uid!==process.getuid() || (st.mode&0o077)!==0)) deny("pnpm output is not an owned private file");
  const target=path.join(directory,index+".combined");
  try{linkSync(file,target)}catch(error){if(error.code!=="EEXIST")throw error}
  const linked=lstatSync(target);
  if(!linked.isFile() || linked.dev!==source.dev || linked.ino!==source.ino) deny("combined output identity changed");
  return checkedStream(target,false).stream;
}

/** Consume only fixed private stream filenames. Raw bytes and diagnostics never enter the publication document. */
export function machineOutcomes(spec, directory) {
  if (
    process.env.CLAUDE_CODE_REMOTE !== "true" ||
    git("rev-parse", "HEAD") !== spec.commit ||
    githubRepository(git("remote", "get-url", "origin"))?.toLowerCase() !== spec.repository.toLowerCase()
  )
    deny("unverified cloud checkout");
  if (git("status", "--porcelain")) deny("checkout has tracked or untracked changes");
  if (
    directory !== realpathSync(directory) ||
    path.dirname(directory) !== realpathSync(tmpdir()) ||
    !/^vibe-lane-results-[a-zA-Z0-9]{6}$/.test(path.basename(directory))
  )
    deny("invalid session-private stream directory");
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || dir.uid !== process.getuid())
    deny("stream directory permissions or owner differ");
  requireOutcomeCapacity(spec.names.length, spec.artifact);
  const lanes = spec.names.map((name, index) => {
    const file = path.join(directory, index + ".json"),
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let rec;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 1024 * 1024) deny("invalid outcome metadata size");
      rec = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
    if (rec.name !== name || (rec.exitCode === null && !rec.notRun))
      deny("actual lane name or missing status differs");
    const evidence = { exitCode: rec.exitCode, diagnosis: rec.diagnosis, privateStreams: {} };
    for (const ch of ["stdout", "stderr"]) {
      const read = checkedStream(
        path.join(directory, index + "." + ch),
        ch === "stdout" && index === spec.probe,
        spec.commit,
        spec.frozen?.includes(index),
      );
      if (read.frozen) evidence.frozen = read.frozen;
      evidence.privateStreams[ch] = read.stream;
      if (read.checks) evidence.checks = read.checks;
      if (read.capabilities) evidence.capabilities = read.capabilities;
    }
    if(spec.combined?.includes(index) && rec.exitCode!==null) evidence.privateStreams.stdout=retainedContainerStream(directory,index,rec.exitCode);
    if (spec.frozen?.includes(index) && rec.exitCode === 0 && evidence.frozen?.verdict !== 1)
      deny("missing successful frozen verdict");
    return evidence;
  });
  return encodeOutcomes({ ...spec, directory: "/tmp/" + path.basename(directory), host: hostname(), lanes });
}
/** Publish only the sanitized outcome document to its expressly requested fresh result ref. */
export function publishOutcomes(artifact, parent, encoded) {
  if(artifact?.kind !== "validation-outcomes") deny("expected typed result artifact");
  checkOutcomeArtifact({ resultArtifact: artifact });
  const ref = "refs/heads/" + artifact.branch;
  if (git("ls-remote", "--refs", "origin", ref))
    deny("result reference already exists; authorize a new proof ref");
  const bytes = JSON.stringify({ version: 1, encoded }) + "\n",
    hash = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(artifact.path, bytes, { flag: "wx", mode: 0o600 });
  git("add", "--", artifact.path);
  git(
    "-c",
    "user.name=Validation outcomes",
    "-c",
    "user.email=validation@fixture.invalid",
    "commit",
    "--only",
    "-m",
    "chore(vibe): record validation outcomes",
    "--",
    artifact.path,
  );
  const child = git("rev-parse", "HEAD");
  if (
    git("rev-list", "--parents", "-n", "1", child) !== child + " " + parent ||
    git("diff-tree", "--no-commit-id", "--name-only", "-r", child) !== artifact.path ||
    git("status", "--porcelain")
  )
    deny("unexpected outcome parent, tree or status");
  const push = git("push", "--porcelain", "origin", child + ":" + ref);
  if (!push.includes("[new branch]") || git("ls-remote", "--refs", "origin", ref).split(/\s+/)[0] !== child)
    deny("result reference was not newly published at the outcome commit");
  return ARTIFACT_MARKER + " " + child + ":" + hash;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const spec = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
    const encoded = machineOutcomes(spec, process.argv[3]);
    const line = spec.artifact ? publishOutcomes(spec.artifact, spec.commit, encoded) : outcomeLine(encoded);
    process.stdout.write(line + "\n");
  } catch (e) {
    process.stderr.write(
      (String(e.message).startsWith("cloud outcome writer:") ||
      String(e.message).startsWith("cloud validation outcome")
        ? e.message
        : "cloud outcome writer: invalid private lane evidence; inspect the session privately") + "\n",
    );
    process.exitCode = 1;
  }
}
