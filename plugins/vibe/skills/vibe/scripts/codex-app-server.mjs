// One request to a short-lived Codex App Server (`codex app-server --stdio`):
// initialize, send the request, return its result, stop the server. Shared by
// cl-sweep's core skill discovery (skills/list) and the vibe-core hook approval
// check (hooks/list).

import { spawn } from "node:child_process";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * The result of `method` with `params` from a Codex App Server started in `cwd`. Rejects with
 * "<label> ..." on a timeout, a server that cannot start or closes first, invalid JSON, an
 * oversized response, or an error reply (whose message is kept, so a caller can tell an
 * App Server that does not know the method).
 */
export function codexAppServerRequest(executable, cwd, method, params, { timeoutMs = 20_000, label = "Codex App Server", clientName = "closedloop_vibe" } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, ["app-server", "--stdio"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      force.unref();
      child.once("close", () => clearTimeout(force));
      if (error) reject(error); else accept(result);
    };
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs);
    child.stderr.resume();
    child.on("error", () => finish(new Error(`${label} could not start`)));
    child.on("close", () => finish(new Error(`${label} closed before answering`)));
    child.stdin.on("error", () => finish(new Error(`${label} input closed`)));
    child.stdout.setEncoding("utf8");
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) return finish(new Error(`${label} response exceeded its bound`));
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, boundary)); } catch { return finish(new Error(`${label} returned invalid JSON`)); }
        buffer = buffer.slice(boundary + 1);
        if (message.error) return finish(new Error(`${label} request failed: ${message.error.message ?? JSON.stringify(message.error)}`));
        if (message.id === "initialize") {
          send({ method: "initialized" });
          send({ id: "request", method, params });
        } else if (message.id === "request") finish(null, message.result);
      }
    });
    send({ id: "initialize", method: "initialize", params: {
      clientInfo: { name: clientName, version: "1.0.0" },
      capabilities: { experimentalApi: true },
    } });
  });
}
