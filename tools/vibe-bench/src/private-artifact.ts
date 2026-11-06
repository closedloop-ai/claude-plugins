import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const LOCAL_PATH = /(?:^|[\s("'=\[{`])\/(?!\/)[^\s"'<>]+|[A-Za-z]:\\|\\\\[^\s\\]+\\/i;
const CREDENTIAL = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*[=:]\s*\S+|\b(?:sk_live|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,})/i;

/** Classify private text that must never be copied into retained or published artifacts. */
export function privateTextProblem(value: string): "local-path" | "credential" | null {
  if (LOCAL_PATH.test(value) || /\b(?:laptop|localhost|local path)\b/i.test(value)) {
    return "local-path";
  }
  return CREDENTIAL.test(value) ? "credential" : null;
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
export function writePrivateReply(destination: string, reply: string): void {
  if (!reply.trim()) throw new Error("eval-private-reply-missing");
  if (privateTextProblem(reply)) throw new Error("eval-private-reply-private-data");
  const caseDir = dirname(destination);
  mkdirSync(caseDir, { recursive: true, mode: 0o700 });
  if (lstatSync(caseDir).isSymbolicLink() || realpathSync(caseDir) !== resolve(caseDir) ||
      existsSync(destination)) throw new Error("eval-private-reply-path-invalid");
  writeFileSync(destination, `${reply.trimEnd()}\n`, { flag: "wx", mode: 0o600 });
}
