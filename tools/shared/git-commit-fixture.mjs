import { execFileSync, spawnSync } from "node:child_process";

function exactCommit(repo, sha) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", `${sha}^{commit}`], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === sha;
}

/** Ensure an immutable test release commit exists without changing checkout state. */
export function ensureGitCommit(repo, sha, remote = "origin") {
  if (!/^[a-f0-9]{40}$/.test(sha) || !remote) throw new Error("test-release-ref-invalid");
  if (exactCommit(repo, sha)) return sha;
  const fetched = spawnSync("git", ["-C", repo, "fetch", "--no-tags", "--depth=1", remote, sha], {
    encoding: "utf8",
  });
  if (fetched.status !== 0 || !exactCommit(repo, sha)) {
    throw new Error(`test-release-fetch-failed:${sha}:${fetched.stderr.trim() || "unknown"}`);
  }
  return sha;
}

/** Resolve fixed releases serially so concurrent tests never race one repository fetch. */
export function ensureGitCommits(repo, shas, remote = "origin") {
  return shas.map((sha) => ensureGitCommit(repo, sha, remote));
}

/**
 * Archive exact committed paths into a run-owned test directory.
 *
 * Never fetches: a fetch here would run inside the caller's test or hook timeout, so that
 * timeout would depend on the network. Fetch with `ensureGitCommits` before tests start.
 */
export function archiveGitFixture(repo, sha, paths, destination) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("test-release-paths-invalid");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("test-release-ref-invalid");
  if (!exactCommit(repo, sha)) {
    throw new Error(`test-release-missing:${sha}: fetch it with ensureGitCommits before tests start, `
      + "never inside a timed test or hook");
  }
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha, ...paths], {
    maxBuffer: 80 * 1024 * 1024,
  });
  const unpack = spawnSync("tar", ["-xf", "-"], {
    cwd: destination,
    input: archive,
    encoding: "utf8",
  });
  if (unpack.status !== 0) {
    throw new Error(`test-release-archive-failed:${unpack.stderr.trim() || "unknown"}`);
  }
}
