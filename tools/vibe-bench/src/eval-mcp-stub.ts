import { createInterface } from "node:readline";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; protocolVersion?: unknown };
}

function operations(argv: string[]): string[] {
  const index = argv.indexOf("--operations");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (typeof value !== "string") throw new Error("eval-mcp-operations-missing");
  const items = value.split(",").filter(Boolean);
  if (items.length === 0 || new Set(items).size !== items.length ||
      items.some((item) => !/^[a-z][a-z0-9_]*$/.test(item))) {
    throw new Error("eval-mcp-operations-invalid");
  }
  return items.sort();
}

/**
 * Serve deterministic read-only graph tools for stateful eval fixtures.
 *
 * The upgrade cases need the granted tool identities to exercise the production
 * worker launcher, but they do not need live graph data to append their proof
 * marker. Keeping the server local removes the operator's user-scoped MCP
 * configuration and remote service availability from the eval boundary.
 */
export function runEvalMcpStub(argv = process.argv.slice(2)): void {
  const granted = operations(argv);
  const available = new Set(granted);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let request: JsonRpcRequest;
    try { request = JSON.parse(line) as JsonRpcRequest; }
    catch { return; }
    if (request.id === undefined || typeof request.method !== "string") return;
    let result: unknown;
    if (request.method === "initialize") {
      const protocolVersion = typeof request.params?.protocolVersion === "string"
        ? request.params.protocolVersion : "2025-06-18";
      result = { protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: "vibe-eval-isolated", version: "1.0.0" } };
    } else if (request.method === "ping") {
      result = {};
    } else if (request.method === "tools/list") {
      result = { tools: granted.map((name) => ({ name,
        description: `Deterministic isolated eval fixture for ${name}`,
        inputSchema: { type: "object", additionalProperties: true } })) };
    } else if (request.method === "tools/call" && typeof request.params?.name === "string" &&
        available.has(request.params.name)) {
      result = { content: [{ type: "text", text: JSON.stringify({
        fixture: "vibe-eval-isolated", operation: request.params.name,
      }) }] };
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
        error: { code: -32601, message: "Method or tool is not granted" } })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  });
}

if (process.argv[1]?.endsWith("eval-mcp-stub.ts")) runEvalMcpStub();
