// Safety rules for text a vibe worker publishes to ClosedLoop (operator
// ruling, 2026-10-19): the session plan that becomes the live ticket's PLN
// follows the same rules as the live ticket body. Two rewrites are mechanical
// and applied here: a path inside the session's own checkout becomes
// repo-relative, and a bare angle-bracketed name becomes a code span so
// ClosedLoop does not strip it (`ticket-template.md`). Anything else that
// would publish a local absolute path, a username or personal email, a secret
// or credential, or a private session input is refused with its line, so
// nothing is published until the writer fixes its own source.

const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`[^`\n]*`/g;
const ANGLE_NAME = /<\/?[A-Za-z][^<>\n]*>/g;

const LOCAL_PATH = /(?:^|[\s("'`=:,[{<])((?:\/(?:Users|home|private|tmp|Volumes|root|var\/folders)\/|~\/|[A-Za-z]:\\(?:Users|Documents and Settings)\\|file:\/\/)[^\s"'`)\]}>]*)/;
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const EXAMPLE_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net|invalid)|test|example|invalid|localhost)$/i;
const SECRETS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["secret key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/],
  ["secret key", /\bsk-(?:[A-Za-z]+-)?[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["AWS key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["PostHog personal key", /\bphx_[A-Za-z0-9]{20,}/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credential in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ["credential in a URL", /[?&](?:closedloopBridgeToken|token|access_token|api_key|apikey|key|secret|password|sig|signature)=[^\s&]{8,}/i],
  ["assigned secret", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?(?=[A-Za-z0-9/+_-]*\d)[A-Za-z0-9/+_-]{16,}/i],
];
// The session's private Git metadata: the record, the writer's queued
// requests, flag and Desktop sign-in files, and the worker scratch files.
const PRIVATE_INPUT = /\b(?:vibe-(?:session|writer|main-sync|flag-snapshot|desktop-auth)\.json|native-owner\.json|claude-operation-owner\.json|vibe-users\/)|\.git\/worktrees\//;

/**
 * Rewrites what is mechanically safe and lists what must be refused.
 * `roots`: absolute checkout paths whose prefix becomes repo-relative (the
 * session worktree first, then the main checkout). `privateWords`: the local
 * account's username, refused as a whole word.
 * Returns `{ text, problems: [{ line, kind }] }`; problems never echo the value.
 */
export function checkPublishableText(input, { roots = [], privateWords = [] } = {}) {
  let text = input.replace(/\r\n/g, "\n");
  for (const root of [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    const base = root.replace(/\/+$/, "");
    text = text.split(`${base}/`).join("").split(base).join(".");
  }
  const words = [...new Set(privateWords.filter((word) => word && word.length >= 3))]
    .map((word) => new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(word)}(?![A-Za-z0-9_-])`, "i"));
  const problems = [];
  let fence = null;
  const lines = text.split("\n").map((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker && (fence === null || fence === marker)) {
      fence = fence === null ? marker : null;
    } else if (fence === null) {
      line = codeSpanAngleNames(line);
    }
    for (const kind of lineProblems(line, words)) {
      problems.push({ line: index + 1, kind });
    }
    return line;
  });
  return { text: lines.join("\n"), problems };
}

function lineProblems(line, words) {
  const kinds = [];
  if (LOCAL_PATH.test(line)) kinds.push("local absolute path");
  if (words.some((word) => word.test(line))) kinds.push("local username");
  for (const match of line.matchAll(EMAIL)) {
    if (!EXAMPLE_EMAIL_DOMAIN.test(match[1])) {
      kinds.push("personal email address");
      break;
    }
  }
  for (const [kind, pattern] of SECRETS) {
    if (pattern.test(line) && !kinds.includes(kind)) kinds.push(kind);
  }
  if (PRIVATE_INPUT.test(line)) kinds.push("private session input");
  return kinds;
}

/** Wraps bare angle-bracketed names in code spans, leaving existing code spans alone. */
function codeSpanAngleNames(line) {
  let result = "";
  let last = 0;
  for (const match of line.matchAll(INLINE_CODE)) {
    result += line.slice(last, match.index).replace(ANGLE_NAME, (name) => `\`${name}\``) + match[0];
    last = match.index + match[0].length;
  }
  return result + line.slice(last).replace(ANGLE_NAME, (name) => `\`${name}\``);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
