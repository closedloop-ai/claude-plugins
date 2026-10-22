import { describe, expect, it } from "vitest";
import { nativeFailureResult, type NativeFailure, producerFailureHead,
  producerReadArguments, terminatedCommitSchema } from "./main-sync-native-failure.js";

describe("structured synchronous native result", () => {
  it.each(["string", "buffer"])("accepts coherent %s exited channels without cmd or identity promotion", kind => {
    const value = fixture();
    if (kind === "buffer") {
      value.stdout = Buffer.from(value.stdout); value.stderr = Buffer.from(value.stderr);
      value.output = [null, value.stdout, value.stderr];
    }
    expect(Object.hasOwn(value, "cmd")).toBe(false);
    expect(nativeFailureResult(value)?.kind).toBe("exited");
    expect(nativeFailureResult(value)).not.toHaveProperty("head");
  });

  it("distinguishes documented nullable signal and spawn-error shapes (faithful doubles only)", () => {
    const value = fixture();
    expect(nativeFailureResult(Object.assign(value, { status: null, signal: "SIGTERM" }))?.kind).toBe("signalled");
    expect(nativeFailureResult(Object.assign(value, { code: "ETIMEDOUT", syscall: "spawnSync git", path: "git",
      spawnargs: ["rev-parse", "HEAD", "--absolute-git-dir"] }))?.kind).toBe("spawn");
    expect(nativeFailureResult(Object.assign(fixture(), { pid: 0, status: null, signal: null,
      code: "ENOENT", syscall: "spawnSync git", path: "git", spawnargs: [],
      stdout: null, stderr: null, output: null }))?.kind).toBe("spawn");
  });

  it.each(["plain", "raw", "pid", "status", "signal", "unknown-null", "channels", "missing-output", "spawn-fields"])(
    "does not accept %s as coherent failed protocol", kind => {
      const value = fixture(); let input: unknown = value;
      if (kind === "plain") input = { ...value };
      if (kind === "raw") input = value.stdout;
      if (kind === "pid") Object.assign(value, { pid: -1 });
      if (kind === "status") Object.assign(value, { status: 0 });
      if (kind === "signal") Object.assign(value, { signal: "SIGTERM" });
      if (kind === "unknown-null") Object.assign(value, { status: null });
      if (kind === "channels") Object.assign(value, { output: [null, "different", value.stderr] });
      if (kind === "missing-output") Reflect.deleteProperty(value, "output");
      if (kind === "spawn-fields") Object.assign(value, { status: null, code: "ENOENT" });
      expect(nativeFailureResult(input)).toBeUndefined();
    });

  it.each([
    [false, 128, null, "exited"], [true, 128, null, "spawn"],
    [false, 128, "SIGTERM", undefined], [true, 128, "SIGTERM", undefined],
    [false, 0, null, undefined], [true, 0, null, "spawn"],
    [false, 0, "SIGTERM", undefined], [true, 0, "SIGTERM", undefined],
    [false, null, "SIGTERM", "signalled"], [true, null, "SIGTERM", "spawn"],
    [false, null, null, undefined], [true, null, null, "spawn"],
  ] as const)("crosses code=%s status=%s signal=%s into %s (source-shaped double)", (code, status, signal, kind) => {
    const value = fixture();
    Object.assign(value, { status, signal });
    if (code) Object.assign(value, { code: "ETIMEDOUT", syscall: "spawnSync git", path: "git", spawnargs: [] });
    if (status === null && signal === null && code) Object.assign(value, { pid: 0, stdout: null, stderr: null, output: null });
    expect(nativeFailureResult(value)?.kind).toBe(kind);
  });
  void compilerNegative;
});

describe.each([["producer", producerFailureHead, producerReadArguments]] as const)(
  "closed %s failed first field", (_name, adapter, args) => {
    it.each([
      [false,128,null,true], [true,128,null,true], [false,128,"SIGTERM",false], [true,128,"SIGTERM",false],
      [false,0,null,false], [true,0,null,true], [false,0,"SIGTERM",false], [true,0,"SIGTERM",false],
      [false,null,"SIGTERM",true], [true,null,"SIGTERM",true], [false,null,null,false], [true,null,null,true],
    ] as const)("code=%s status=%s signal=%s establishes first=%s (faithful double)", (code,status,signal,proved) => {
      const value = fixture(); Object.assign(value, { status,signal,
        message:`Command failed: git ${args.join(" ")}\n${value.stderr}` });
      if (code) Object.assign(value, { code:"ETIMEDOUT",syscall:"spawnSync git",path:"git",spawnargs:[...args],message:"spawnSync git ETIMEDOUT" });
      expect(adapter(value)).toEqual(proved ? {kind:"proved",head:"b".repeat(40)} : {kind:"unproved"});
    });
    it.each(["cross-context","wrong-command","raw","plain","nonterminated","unborn","missing-output"])(
      "keeps %s unproved", kind => {
        const value = fixture(); value.message=`Command failed: git ${args.join(" ")}\n${value.stderr}`;
        let input: unknown=value;
        if(kind==="cross-context") value.message="Command failed: git rev-parse HEAD origin/main\n";
        if(kind==="wrong-command") value.message="Command failed: other HEAD origin/main\n";
        if(kind==="raw") input=value.stdout;
        if(kind==="plain") input={...value};
        if(kind==="nonterminated" || kind==="unborn") {
          value.stdout=kind==="nonterminated" ? "b".repeat(40) : "HEAD\n";
          value.output=[null,value.stdout,value.stderr];
        }
        if(kind==="missing-output") Reflect.deleteProperty(value,"output");
        expect(adapter(input)).toEqual({kind:"unproved"});
      });
    it("shares Buffer parsing without letting data alone attest provenance", () => {
      const value=fixture(); value.message=`Command failed: git ${args.join(" ")}\n${value.stderr}`;
      value.stdout=Buffer.from(value.stdout); value.output=[null,value.stdout,value.stderr];
      expect(adapter(value)).toEqual({kind:"proved",head:"b".repeat(40)});
      expect(terminatedCommitSchema.parse("b".repeat(40)+"\nnot-a-main")).toBe("b".repeat(40));
      expect(Object.isFrozen(args)).toBe(true);
    });
  });

function fixture(): Error & { pid: number; status: number; signal: string | null;
  stdout: string | Buffer; stderr: string | Buffer; output: [null, string | Buffer, string | Buffer] } {
  const stdout: string | Buffer = "b".repeat(40) + "\n";
  const stderr: string | Buffer = "synthetic failure\n";
  return Object.assign(new Error("Command failed: git rev-parse HEAD --absolute-git-dir\n" + stderr), {
    pid: 123, status: 128, signal: null as string | null, stdout, stderr,
    output: [null, stdout, stderr] as [null, string | Buffer, string | Buffer],
  });
}

function compilerNegative(value: NativeFailure) {
  // @ts-expect-error A result cannot omit its required failure variant.
  const omitted: NativeFailure = { pid: 123, status: null, signal: null, stdout: null, stderr: null, output: null, message: "failure" };
  // @ts-expect-error Code fields cannot bypass mutually exclusive termination fields.
  const contradictory: NativeFailure = { kind: "spawn", pid: 123, status: 128, signal: "SIGTERM", stdout: null, stderr: null, output: null, message: "spawnSync git ETIMEDOUT", code: "ETIMEDOUT", syscall: "spawnSync git", path: "git", spawnargs: [] };
  if (value.kind === "exited") {
    // @ts-expect-error Exited status cannot be unproved/null.
    const status: null = value.status;
    void status;
  }
  void omitted;
  void contradictory;
}
