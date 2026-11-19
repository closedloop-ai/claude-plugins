import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// Q-14162-6 (f): only a real absolute path counts, so a slash command, a JSX comment or a
// URL query value that merely starts with "/" is not private. Q-14162-11: system tool roots
// (usr, bin, sbin, lib, etc, dev, proc, sys, boot) hold no user data, so `/usr/bin/git` is not private.
const LOCAL_PATH = /(?:^|[\s("'=\[{`])\/(?:Users|home|private|tmp|var|opt|Volumes|Applications|Library|System|root|mnt|media|srv|run|nix|snap|cores)\/[^\s"'<>]|[A-Za-z]:\\|\\\\[^\s\\]+\\/i;
const LOCAL_FILE_URI = /\bfile:(?:\/\/[^/\s"'<>]*\/|\/)[^\s"'<>]+/i;
const LOCAL_WORD = /\b(?:laptop|localhost|local path)\b/i;
// Private-network literals name a machine; loopback does not, so `localhost` is judged only as a word.
const PRIVATE_ADDRESS = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;
const TOKEN_END = /[\s"'<>`)\]}]/;
const CREDENTIAL = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*[=:]\s*\S+|\b(?:sk_live|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})/i;

/** Classify private text that must never be copied into retained or published artifacts. */
export function privateTextProblem(value: string): "local-path" | "credential" | null {
  if (LOCAL_PATH.test(value) || LOCAL_FILE_URI.test(value) || LOCAL_WORD.test(value)) {
    return "local-path";
  }
  return CREDENTIAL.test(value) ? "credential" : null;
}

/** What made an eval reply private; never the matched text. */
export type PrivateReplyCategory = "absolute-path" | "file-uri" | "hostname" | "credential";

/**
 * Classify private text in a model reply to one eval case. Unlike the artifact policy it ignores the bare
 * words "laptop", "localhost" and "local path", which a user-facing reply may say, and it accepts a path,
 * file URI or address that the case's own input already supplied. Credentials are never accepted.
 */
export function privateReplyProblem(reply: string, caseInput = ""): PrivateReplyCategory | null {
  const findings: Array<[PrivateReplyCategory, string]> = [];
  for (const [category, pattern] of [["absolute-path", LOCAL_PATH], ["file-uri", LOCAL_FILE_URI],
    ["hostname", PRIVATE_ADDRESS]] as const) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of reply.matchAll(global)) {
      const start = match.index + match[0].search(/[\\/A-Za-z0-9]/);
      findings.push([category, tokenFrom(reply, start, match.index + match[0].length)]);
    }
  }
  for (const [category, token] of findings) {
    if (!inputContainsToken(caseInput, token)) return category;
  }
  return CREDENTIAL.test(reply) ? "credential" : null;
}

function tokenFrom(text: string, start: number, matchEnd: number): string {
  let end = matchEnd;
  while (end < text.length && !TOKEN_END.test(text[end])) end += 1;
  return text.slice(start, end).replace(/[.,;:!?]+$/, "");
}

function inputContainsToken(input: string, token: string): boolean {
  if (!token) return false;
  for (let from = input.indexOf(token); from !== -1; from = input.indexOf(token, from + 1)) {
    if (!/[\w-]/.test(input[from + token.length] ?? "")) return true;
  }
  return false;
}

/** Validate one run-owned private reply destination before any bytes are written. */
export function privateReplyDestination(root: string, caseId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,159}$/.test(caseId)) {
    throw new Error("eval-private-reply-case-invalid");
  }
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("eval-private-reply-root-invalid");
  }
  const canonicalRoot = realpathSync(root);
  const caseDir = join(canonicalRoot, caseId);
  const relativeCase = relative(canonicalRoot, caseDir);
  if (!relativeCase || relativeCase.startsWith("..") || isAbsolute(relativeCase)) {
    throw new Error("eval-private-reply-path-invalid");
  }
  const caseStat = lstatSync(caseDir, { throwIfNoEntry: false });
  if (caseStat && (!caseStat.isDirectory() || caseStat.isSymbolicLink())) {
    throw new Error("eval-private-reply-path-invalid");
  }
  const destination = join(caseDir, "reply.txt");
  if (existsSync(destination)) throw new Error("eval-private-reply-clobber");
  return destination;
}

/** Write only validated final reply text to a preflighted run-owned destination. */
export function writePrivateReply(destination: string, reply: string, caseInput = ""): void {
  if (!reply.trim()) throw new Error("eval-private-reply-missing");
  if (privateReplyProblem(reply, caseInput)) throw new Error("eval-private-reply-private-data");
  const caseDir = dirname(destination);
  mkdirSync(caseDir, { recursive: true, mode: 0o700 });
  if (lstatSync(caseDir).isSymbolicLink() || realpathSync(caseDir) !== resolve(caseDir) ||
      existsSync(destination)) throw new Error("eval-private-reply-path-invalid");
  writeFileSync(destination, `${reply.trimEnd()}\n`, { flag: "wx", mode: 0o600 });
}
