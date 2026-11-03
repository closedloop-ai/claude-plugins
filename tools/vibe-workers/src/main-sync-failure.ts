import { basename } from "node:path";
import { z } from "zod";
import { MainSyncError } from "./main-sync-contracts.js";

const PRESERVE = "preserve the operation and inspect its owned evidence";
const INVALID = "Main-sync context or private evidence is invalid";
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SYSCALL = /^[a-z][A-Za-z]{1,31}(?: [A-Za-z0-9._-]{1,64})?$/;
const FILE_NAME = /^[A-Za-z0-9._@+-]{1,128}$/;
const COMMAND_WORD = /^[a-z][a-z0-9-]{0,39}$/;
const FAILED_COMMAND = /^Command failed: (\S+)(?: (\S+))?/;
const STACK_FRAME = /\(?(?:file:\/\/)?(\/[^():]+\.[cm]?[jt]s):(\d+):\d+\)?$/;
const MAX_MESSAGE = 240;
const PATH_SEGMENT = /^[A-Za-z0-9_.@+-]{1,64}$/;
const MAX_ISSUES = 3;

type OperationalError = Error & { code?: unknown; syscall?: unknown; path?: unknown; status?: unknown; signal?: unknown; output?: unknown };

/** Existing worker outcomes stay compact and never echo stdin context, command output, a lease or private file contents.
 * Malformed context or private evidence (schema or JSON) keeps the invalid-evidence refusal; any other cause is named without its payload. */
export function mainSyncFailure(error: unknown) {
  if (error instanceof MainSyncError) return { status: error.status, error: error.message };
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { status: "BLOCKED" as const, error: `${INVALID} (${failureCause(error)}); ${PRESERVE}` };
  return { status: "BLOCKED" as const, error: `Main-sync stopped on an operational error (${failureCause(error)}); ${PRESERVE}` };
}

/** The same secret-free cause, for a step that keeps its own refusal but must not hide why it refused. */
export function failureCause(error: unknown) {
  // Schema issues are named by key path and issue code only; JSON parse messages quote the private bytes and are dropped.
  if (error instanceof z.ZodError) return `schema: ${schemaIssues(error)}`;
  if (error instanceof SyntaxError) return `malformed JSON${sourceFrame(error.stack)}`;
  return operationalCause(error);
}

function operationalCause(error: unknown) {
  if (!(error instanceof Error)) return "non-Error exception";
  const fields: OperationalError = error;
  const where = sourceFrame(error.stack);
  if (Array.isArray(fields.output) || error.message.startsWith("Command failed:")) {
    // Child-process messages carry stderr, which can hold remote URLs or tokens; only the command words are kept.
    const words = (FAILED_COMMAND.exec(error.message)?.slice(1) ?? []).filter((word): word is string => Boolean(word))
      .map((word, index) => index === 0 ? basename(word) : word).filter((word) => COMMAND_WORD.test(word));
    const ended = typeof fields.status === "number" ? `exited ${fields.status}`
      : typeof fields.signal === "string" && ERROR_CODE.test(fields.signal) ? `stopped by ${fields.signal}` : "failed";
    return `subprocess ${words.length ? `${words.join(" ")} ` : ""}${ended}${where}`;
  }
  if (typeof fields.code === "string" && ERROR_CODE.test(fields.code)) {
    // Coded Node errors may embed received values in their message, so only structured fields are kept.
    const syscall = typeof fields.syscall === "string" && SYSCALL.test(fields.syscall) ? ` during ${fields.syscall}` : "";
    const file = typeof fields.path === "string" && FILE_NAME.test(basename(fields.path)) ? ` on ${basename(fields.path)}` : "";
    return `${error.name} ${fields.code}${syscall}${file}${where}`;
  }
  const message = error.message.split("\n", 1)[0]!.slice(0, MAX_MESSAGE);
  return `${error.name}: ${message}${where}`;
}

function schemaIssues(error: z.ZodError) {
  const issues = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.map((segment) => typeof segment === "number" || PATH_SEGMENT.test(segment) ? String(segment) : "*").join(".");
    return `${path || "(root)"} ${issue.code}`;
  });
  return `${issues.join(", ")}${error.issues.length > MAX_ISSUES ? ` and ${error.issues.length - MAX_ISSUES} more` : ""}`;
}

function sourceFrame(stack: string | undefined) {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const frame = STACK_FRAME.exec(line.trim());
    if (frame && !frame[1]!.includes("/node_modules/")) return ` at ${basename(frame[1]!)}:${frame[2]}`;
  }
  return "";
}
