/** Tests for upload-inline-images.ts */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractPlaceholders,
  main,
  mimeFor,
  stripFailed,
  substitute,
} from "./upload-inline-images.js";

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

describe("extractPlaceholders", () => {
  it("returns empty array when no placeholders", () => {
    expect(extractPlaceholders("# No images here\n\nJust text.")).toEqual([]);
  });

  it("extracts a single placeholder path", () => {
    const body = "![alt](attachment://{{shots/foo.png}})";
    expect(extractPlaceholders(body)).toEqual(["shots/foo.png"]);
  });

  it("extracts multiple unique placeholder paths", () => {
    const body = [
      "![a](attachment://{{a.png}})",
      "some text",
      "![b](attachment://{{b/sub.jpg}})",
    ].join("\n");
    expect(extractPlaceholders(body)).toEqual(["a.png", "b/sub.jpg"]);
  });

  it("deduplicates repeated paths, preserving first-seen order", () => {
    const body = [
      "![first](attachment://{{dup.png}})",
      "![second](attachment://{{dup.png}})",
      "![third](attachment://{{other.png}})",
    ].join("\n");
    expect(extractPlaceholders(body)).toEqual(["dup.png", "other.png"]);
  });
});

describe("substitute", () => {
  it("replaces placeholder paths with attachment ids", () => {
    const body = "![x](attachment://{{shots/a.png}}) end";
    const map = new Map([["shots/a.png", "att-abc123"]]);
    expect(substitute(body, map)).toBe("![x](attachment://att-abc123) end");
  });

  it("leaves unknown paths untouched", () => {
    const body = "![x](attachment://{{unknown.png}})";
    expect(substitute(body, new Map())).toBe(body);
  });

  it("replaces all occurrences of the same path", () => {
    const body = [
      "![a](attachment://{{foo.png}})",
      "![b](attachment://{{foo.png}})",
    ].join("\n");
    const map = new Map([["foo.png", "att-xyz"]]);
    const result = substitute(body, map);
    expect(result).toBe(
      "![a](attachment://att-xyz)\n![b](attachment://att-xyz)",
    );
  });
});

describe("stripFailed", () => {
  it("returns body unchanged when failedPaths is empty", () => {
    const body = "![x](attachment://{{ok.png}})";
    expect(stripFailed(body, [])).toBe(body);
  });

  it("strips lines whose path is in failedPaths", () => {
    const body = [
      "before",
      "![bad](attachment://{{bad.png}})",
      "after",
    ].join("\n");
    expect(stripFailed(body, ["bad.png"])).toBe("before\nafter");
  });

  it("leaves lines for non-failed paths intact", () => {
    const body = [
      "![good](attachment://{{good.png}})",
      "![bad](attachment://{{bad.png}})",
    ].join("\n");
    expect(stripFailed(body, ["bad.png"])).toBe(
      "![good](attachment://{{good.png}})",
    );
  });
});

describe("mimeFor", () => {
  it("returns correct mime types for known extensions", () => {
    expect(mimeFor("foo.png")).toBe("image/png");
    expect(mimeFor("foo.jpg")).toBe("image/jpeg");
    expect(mimeFor("foo.jpeg")).toBe("image/jpeg");
    expect(mimeFor("foo.gif")).toBe("image/gif");
    expect(mimeFor("foo.webp")).toBe("image/webp");
  });

  it("returns null for unknown extensions", () => {
    expect(mimeFor("foo.svg")).toBeNull();
    expect(mimeFor("foo.bmp")).toBeNull();
    expect(mimeFor("foo")).toBeNull();
    expect(mimeFor("foo.PDF")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(mimeFor("FOO.PNG")).toBe("image/png");
    expect(mimeFor("BAR.JPG")).toBe("image/jpeg");
  });
});

// ---------------------------------------------------------------------------
// Integration test helpers
// ---------------------------------------------------------------------------

/** Minimal PNG bytes (8-byte PNG signature only — enough to be a real file). */
const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface ServerConfig {
  /** Status to return for POST /documents/:id/attachments */
  postStatus?: number;
  /** Body to return for POST */
  postBody?: object;
  /** Status to return for PUT /upload/:key */
  putStatus?: number;
  /** Accumulated PUT payload info */
  capturedPuts: Array<{ key: string; byteLength: number; contentType: string }>;
  /** Accumulated POST auth headers */
  capturedPostAuths: string[];
}

/** Spin up a minimal http server that implements the FEA-1762 contract. */
function createTestServer(cfg: ServerConfig): http.Server {
  return http.createServer((req, res) => {
    let body = Buffer.alloc(0);

    req.on("data", (chunk: Buffer) => {
      body = Buffer.concat([body, chunk]);
    });

    req.on("end", () => {
      const { method, url } = req;

      // POST /documents/:id/attachments
      const postMatch = /^\/documents\/([^/]+)\/attachments$/.exec(url ?? "");
      if (method === "POST" && postMatch) {
        cfg.capturedPostAuths.push(req.headers["authorization"] ?? "");
        const status = cfg.postStatus ?? 200;
        res.writeHead(status, { "Content-Type": "application/json" });
        if (status === 200) {
          const responseBody = cfg.postBody ?? {
            attachmentId: "att-test-id",
            uploadUrl: `http://localhost:${(res.socket as { localPort?: number }).localPort ?? 0}/upload/testkey`,
            key: "testkey",
          };
          res.end(JSON.stringify(responseBody));
        } else {
          res.end(JSON.stringify({ error: "error" }));
        }
        return;
      }

      // PUT /upload/:key
      const putMatch = /^\/upload\/([^/]+)$/.exec(url ?? "");
      if (method === "PUT" && putMatch) {
        cfg.capturedPuts.push({
          key: putMatch[1] ?? "",
          byteLength: body.length,
          contentType: req.headers["content-type"] ?? "",
        });
        res.writeHead(cfg.putStatus ?? 200, {});
        res.end();
        return;
      }

      res.writeHead(404, {});
      res.end();
    });
  });
}

/** Start the server and return its base URL and port. */
function startServer(server: http.Server): Promise<{ baseUrl: string; port: number }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, port: addr.port });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("main (integration)", () => {
  let tmpDir: string;
  let server: http.Server;
  let cfg: ServerConfig;
  let baseUrl: string;
  const TOKEN = "test-token-abc";
  const TOKEN_ENV = "TEST_UPLOAD_TOKEN";
  const DOC_ID = "doc-99";

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "upload-inline-test-"));
    cfg = {
      capturedPuts: [],
      capturedPostAuths: [],
    };
    server = createTestServer(cfg);
    ({ baseUrl } = await startServer(server));

    // Patch uploadUrl to use the real port (server is now listening)
    const port = (server.address() as { port: number }).port;
    cfg.postBody = {
      attachmentId: "att-test-id",
      uploadUrl: `http://127.0.0.1:${port}/upload/testkey`,
      key: "testkey",
    };

    // Set token env
    process.env[TOKEN_ENV] = TOKEN;
  });

  afterEach(async () => {
    delete process.env[TOKEN_ENV];
    await stopServer(server);
  });

  it("happy path: substitutes placeholders and PUT receives exact bytes", async () => {
    const imgPath = join(tmpDir, "shot.png");
    writeFileSync(imgPath, MINIMAL_PNG);

    const bodyPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.md");
    const body = `# Title\n\n![design region](attachment://{{${imgPath}}})\n\nEnd.`;
    writeFileSync(bodyPath, body, "utf-8");

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", bodyPath,
      "--out", outPath,
      "--token-env", TOKEN_ENV,
    ]);

    expect(code).toBe(0);

    const outBody = readFileSync(outPath, "utf-8");
    expect(outBody).toContain("![design region](attachment://att-test-id)");
    expect(outBody).not.toContain("{{");

    // PUT received exact byte count
    expect(cfg.capturedPuts).toHaveLength(1);
    expect(cfg.capturedPuts[0]!.byteLength).toBe(MINIMAL_PNG.length);
    expect(cfg.capturedPuts[0]!.contentType).toBe("image/png");

    // Bearer token was sent
    expect(cfg.capturedPostAuths[0]).toBe(`Bearer ${TOKEN}`);
  });

  it("endpoint 404 -> exit 3 and --out NOT written", async () => {
    cfg.postStatus = 404;

    const imgPath = join(tmpDir, "shot.png");
    writeFileSync(imgPath, MINIMAL_PNG);

    const bodyPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.md");
    writeFileSync(bodyPath, `![x](attachment://{{${imgPath}}})`, "utf-8");

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", bodyPath,
      "--out", outPath,
      "--token-env", TOKEN_ENV,
    ]);

    expect(code).toBe(3);
    // out file must not exist
    expect(() => readFileSync(outPath)).toThrow();
  });

  it("endpoint 405 -> exit 3 and --out NOT written", async () => {
    cfg.postStatus = 405;

    const imgPath = join(tmpDir, "shot.png");
    writeFileSync(imgPath, MINIMAL_PNG);

    const bodyPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.md");
    writeFileSync(bodyPath, `![x](attachment://{{${imgPath}}})`, "utf-8");

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", bodyPath,
      "--out", outPath,
      "--token-env", TOKEN_ENV,
    ]);

    expect(code).toBe(3);
    expect(() => readFileSync(outPath)).toThrow();
  });

  it("endpoint 401 -> exit 4", async () => {
    cfg.postStatus = 401;

    const imgPath = join(tmpDir, "shot.png");
    writeFileSync(imgPath, MINIMAL_PNG);

    const bodyPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.md");
    writeFileSync(bodyPath, `![x](attachment://{{${imgPath}}})`, "utf-8");

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", bodyPath,
      "--out", outPath,
      "--token-env", TOKEN_ENV,
    ]);

    expect(code).toBe(4);
  });

  it("missing token -> exit 4", async () => {
    delete process.env[TOKEN_ENV];

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", join(tmpDir, "in.md"),
      "--out", join(tmpDir, "out.md"),
      "--token-env", TOKEN_ENV,
    ]);

    expect(code).toBe(4);
  });

  it("one bad path is stripped; valid paths are substituted", async () => {
    const goodPath = join(tmpDir, "good.png");
    writeFileSync(goodPath, MINIMAL_PNG);
    const badPath = join(tmpDir, "nonexistent.png"); // does not exist

    const bodyPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.md");
    const body = [
      "# Doc",
      `![good](attachment://{{${goodPath}}})`,
      `![bad](attachment://{{${badPath}}})`,
      "End.",
    ].join("\n");
    writeFileSync(bodyPath, body, "utf-8");

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", bodyPath,
      "--out", outPath,
      "--token-env", TOKEN_ENV,
    ]);

    expect(code).toBe(0);

    const outBody = readFileSync(outPath, "utf-8");
    // Good path is substituted
    expect(outBody).toContain("attachment://att-test-id");
    // Bad path line is stripped entirely
    expect(outBody).not.toContain(badPath);
    expect(outBody).not.toContain("{{");
    // Non-image text survives
    expect(outBody).toContain("End.");
  });

  it("--probe-only against 400 responder -> exit 0 and prints 'capable'", async () => {
    cfg.postStatus = 400;

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--token-env", TOKEN_ENV,
      "--probe-only",
    ]);

    console.log = origLog;

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("capable"))).toBe(true);
  });

  it("--probe-only against 404 responder -> exit 3", async () => {
    cfg.postStatus = 404;

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--token-env", TOKEN_ENV,
      "--probe-only",
    ]);

    expect(code).toBe(3);
  });

  it("--probe-only against 401 responder -> exit 4", async () => {
    cfg.postStatus = 401;

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--token-env", TOKEN_ENV,
      "--probe-only",
    ]);

    expect(code).toBe(4);
  });

  it("no placeholders -> writes body as-is with uploaded:0", async () => {
    const bodyPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.md");
    const body = "# No images\n\nJust text.";
    writeFileSync(bodyPath, body, "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", bodyPath,
      "--out", outPath,
      "--token-env", TOKEN_ENV,
    ]);

    console.log = origLog;

    expect(code).toBe(0);
    expect(readFileSync(outPath, "utf-8")).toBe(body);
    const summary = JSON.parse(logs[logs.length - 1] ?? "{}") as {
      uploaded: number;
      stripped: string[];
      documentId: string;
    };
    expect(summary.uploaded).toBe(0);
    expect(summary.stripped).toEqual([]);
    expect(summary.documentId).toBe(DOC_ID);
  });

  it("summary JSON contains correct uploaded count and documentId", async () => {
    const imgPath = join(tmpDir, "s.png");
    writeFileSync(imgPath, MINIMAL_PNG);

    const bodyPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.md");
    writeFileSync(bodyPath, `![x](attachment://{{${imgPath}}})`, "utf-8");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", bodyPath,
      "--out", outPath,
      "--token-env", TOKEN_ENV,
    ]);

    console.log = origLog;

    expect(code).toBe(0);
    const summary = JSON.parse(logs[logs.length - 1] ?? "{}") as {
      uploaded: number;
      stripped: string[];
      documentId: string;
    };
    expect(summary.uploaded).toBe(1);
    expect(summary.stripped).toEqual([]);
    expect(summary.documentId).toBe(DOC_ID);
  });

  it("uses --shots-root to resolve relative paths", async () => {
    const imgPath = join(tmpDir, "relative.png");
    writeFileSync(imgPath, MINIMAL_PNG);

    const bodyPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.md");
    // Use a relative name that resolves against tmpDir
    const body = `![x](attachment://{{relative.png}})`;
    writeFileSync(bodyPath, body, "utf-8");

    const code = await main([
      "--document-id", DOC_ID,
      "--api-base", baseUrl,
      "--body", bodyPath,
      "--out", outPath,
      "--shots-root", tmpDir,
      "--token-env", TOKEN_ENV,
    ]);

    expect(code).toBe(0);
    const outBody = readFileSync(outPath, "utf-8");
    expect(outBody).toContain("attachment://att-test-id");
  });
});
