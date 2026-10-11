import { z } from "zod";
import { validationCommitSchema } from "./main-sync-validation-contracts.js";

export const producerReadArguments = Object.freeze(["rev-parse", "HEAD", "--absolute-git-dir"] as const);
export const budgetRefReadArguments = Object.freeze(["rev-parse", "HEAD", "origin/main"] as const);
/** Data syntax only; the fixed native caller establishes provenance separately. */
export const terminatedCommitSchema = z.string().refine(value => value.includes("\n"))
  .transform(value => value.slice(0, value.indexOf("\n"))).pipe(validationCommitSchema);
type FirstFailureHead = { kind: "unproved" } | { kind: "proved"; head: string };
type FixedReadArguments = typeof producerReadArguments | typeof budgetRefReadArguments;

const channelSchema = z.union([z.string(), z.instanceof(Buffer), z.null()]);
const resultSchema = z.object({
  message: z.string(), pid: z.number().int().nonnegative(),
  status: z.number().int().nullable(), signal: z.string().min(1).nullable(),
  stdout: channelSchema, stderr: channelSchema,
  output: z.tuple([z.null(), channelSchema, channelSchema]).nullable(),
  code: z.string().optional(), syscall: z.string().optional(),
  path: z.string().optional(), spawnargs: z.array(z.string()).optional(),
}).and(z.union([
  z.object({ status: z.number().int(), signal: z.null() }),
  z.object({ status: z.null(), signal: z.string().min(1).nullable() }),
]));
type NativeResult = z.infer<typeof resultSchema>;

/** Structured result only; the fixed caller must establish invocation and field provenance. */
export type NativeFailure =
  | (NativeResult & { kind: "exited"; status: number; signal: null })
  | (NativeResult & { kind: "signalled"; status: null; signal: string })
  | (NativeResult & { kind: "spawn"; code: string; syscall: string; path: string; spawnargs: string[] });

/** Validate Node's synchronous failure channels without accepting caller-supplied trust. */
export function nativeFailureResult(error: unknown): NativeFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const parsed = resultSchema.safeParse(error);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  if (value.output === null) {
    if (value.stdout !== null || value.stderr !== null) return undefined;
  } else if (!sameChannel(value.stdout, value.output[1]) || !sameChannel(value.stderr, value.output[2])) return undefined;
  if (value.code !== undefined) {
    if (!value.code || !value.syscall || !value.path || !value.spawnargs) return undefined;
    return { ...value, kind: "spawn", code: value.code,
      syscall: value.syscall, path: value.path, spawnargs: value.spawnargs };
  }
  if (value.status !== null) {
    if (value.status === 0 || value.signal !== null || value.pid === 0) return undefined;
    return { ...value, kind: "exited", status: value.status, signal: null };
  }
  if (value.signal !== null) {
    if (value.pid === 0) return undefined;
    return { ...value, kind: "signalled", status: null, signal: value.signal };
  }
  return undefined;
}

function sameChannel(left: z.infer<typeof channelSchema>, right: z.infer<typeof channelSchema>) {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

/** Only the producer's fixed failed invocation can establish this first field. */
export function producerFailureHead(error: unknown): FirstFailureHead {
  return fixedFailureHead(error, producerReadArguments);
}

/** Only the budget's fixed failed invocation can establish this first field. */
export function budgetFailureHead(error: unknown): FirstFailureHead {
  return fixedFailureHead(error, budgetRefReadArguments);
}

function fixedFailureHead(error: unknown, args: FixedReadArguments): FirstFailureHead {
  const native = nativeFailureResult(error);
  if (!native || !fixedFailure(native, args) || native.stdout === null) return { kind: "unproved" };
  const output = Buffer.isBuffer(native.stdout) ? native.stdout.toString("utf8") : native.stdout;
  const parsed = terminatedCommitSchema.safeParse(output);
  return parsed.success ? { kind: "proved", head: parsed.data } : { kind: "unproved" };
}

function fixedFailure(native: NativeFailure, args: FixedReadArguments) {
  if (native.kind === "spawn") {
    return native.path === "git" && native.syscall === "spawnSync git"
      && JSON.stringify(native.spawnargs) === JSON.stringify(args)
      && native.message.split("\n", 1)[0] === `spawnSync git ${native.code}`;
  }
  return native.message.split("\n", 1)[0] === `Command failed: git ${args.join(" ")}`;
}
