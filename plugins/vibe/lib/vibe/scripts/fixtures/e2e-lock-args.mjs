import { spawnSync } from "node:child_process";
import {fileURLToPath} from 'node:url';
const SCRIPT = fileURLToPath(new URL('../e2e-lock.mjs', import.meta.url));

export function isolatedArgs(command, args) {
  return command === process.execPath && args?.[0] === SCRIPT && args.includes('--lock-dir') && ['run', 'status'].includes(args[1])
    ? [fileURLToPath(new URL('./e2e-lock-cli.mjs', import.meta.url)), ...args.slice(1)] : args;
}

/** Initialize an isolated repository with a deterministic empty base for machine-slot checks. */
export const commitAt = (dir) => {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: "2026-10-22T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-22T00:00:00Z" };
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).stdout.trim();
  git("init", "--quiet", "--initial-branch=main");
  git("commit", "--quiet", "--allow-empty", "-m", "base");
  return git("rev-parse", "HEAD");
};
