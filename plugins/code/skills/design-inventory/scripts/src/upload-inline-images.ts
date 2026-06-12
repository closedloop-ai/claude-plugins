/**
 * FEA-1762: Inline-image upload helper (PLN-859 Revision 2 P3).
 *
 * Finds `![...](attachment://{{path}})` placeholders in a markdown body,
 * uploads each image to the ClosedLoop attachments API, then writes a new
 * body with attachment-ids substituted in place of paths. Paths that fail
 * (missing file, unsupported mime, upload error) have their entire image line
 * stripped rather than leaving a broken attachment reference.
 *
 * Usage:
 *   node upload-inline-images.mjs \
 *     --document-id <id> --api-base <url> \
 *     --body <in.md> --out <out.md> \
 *     [--shots-root <dir>] [--token-env <NAME>] [--probe-only]
 *
 * Exit codes:
 *   0  success (or probe says capable)
 *   3  endpoint absent / network error
 *   4  auth failure or missing token
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runWhenMain } from "./cli.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The placeholder regex: matches `![alt](attachment://{{path}})` */
const PLACEHOLDER_RE = /!\[[^\]]*\]\(attachment:\/\/\{\{([^}]+)\}\}\)/g;

/** Extract unique placeholder paths from a markdown body. */
export function extractPlaceholders(body: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(PLACEHOLDER_RE.source, "g");
  while ((match = re.exec(body)) !== null) {
    const path = match[1];
    if (path !== undefined && !seen.has(path)) {
      seen.add(path);
      results.push(path);
    }
  }
  return results;
}

/** Map from placeholder path to attachment id — substitute all occurrences. */
export function substitute(body: string, map: Map<string, string>): string {
  return body.replace(PLACEHOLDER_RE, (full, path: string) => {
    const attachmentId = map.get(path);
    return attachmentId !== undefined
      ? full.replace(`{{${path}}}`, attachmentId)
      : full;
  });
}

/**
 * Remove every image line whose placeholder path is in `failedPaths`.
 * Matches lines of the form `![...](attachment://{{path}})` with optional
 * leading spaces, followed by an optional trailing newline.
 */
export function stripFailed(body: string, failedPaths: string[]): string {
  if (failedPaths.length === 0) return body;
  const pathSet = new Set(failedPaths);
  return body
    .split("\n")
    .filter((line) => {
      const match = /!\[[^\]]*\]\(attachment:\/\/\{\{([^}]+)\}\}\)/.exec(line);
      if (!match) return true;
      return !pathSet.has(match[1] ?? "");
    })
    .join("\n");
}

/** Derive MIME type from file extension. Returns null for unsupported types. */
export function mimeFor(path: string): string | null {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface AttachmentResponse {
  attachmentId: string;
  uploadUrl: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function postAttachment(
  apiBase: string,
  documentId: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const url = `${apiBase}/documents/${documentId}/attachments`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { status: resp.status, body };
}

async function putFileBytes(
  uploadUrl: string,
  bytes: Buffer,
  mimeType: string,
): Promise<{ status: number }> {
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: bytes,
  });
  return { status: resp.status };
}

// ---------------------------------------------------------------------------
// Probe-only mode
// ---------------------------------------------------------------------------

/**
 * POST an intentionally invalid payload to test whether the endpoint exists.
 * 400 -> "capable" (exit 0); 404/405 -> exit 3; 401/403 -> exit 4; network error -> exit 3.
 */
async function runProbe(
  apiBase: string,
  documentId: string,
  token: string,
): Promise<number> {
  let status: number;
  try {
    const result = await postAttachment(apiBase, documentId, token, {});
    status = result.status;
  } catch (err) {
    console.error(
      `network error probing attachments endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 3;
  }

  if (status === 400) {
    console.log("capable");
    return 0;
  }
  if (status === 404 || status === 405) {
    console.error(
      `attachments endpoint absent (HTTP ${status}); feature not deployed`,
    );
    return 3;
  }
  if (status === 401 || status === 403) {
    console.error(`auth failure probing attachments endpoint (HTTP ${status})`);
    return 4;
  }
  // Unexpected: treat as absent/network issue
  console.error(`unexpected status ${status} from attachments endpoint`);
  return 3;
}

// ---------------------------------------------------------------------------
// Upload summary
// ---------------------------------------------------------------------------

interface UploadSummary {
  uploaded: number;
  stripped: string[];
  documentId: string;
}

// ---------------------------------------------------------------------------
// Main upload logic
// ---------------------------------------------------------------------------

async function uploadImages(
  body: string,
  documentId: string,
  apiBase: string,
  token: string,
  shotsRoot: string | undefined,
  outPath: string,
): Promise<number> {
  const paths = extractPlaceholders(body);

  if (paths.length === 0) {
    // Nothing to upload; write body as-is.
    writeFileSync(outPath, body, "utf-8");
    const summary: UploadSummary = { uploaded: 0, stripped: [], documentId };
    console.log(JSON.stringify(summary));
    return 0;
  }

  // Resolve paths and validate files upfront.
  const resolvedPaths = new Map<string, string>(); // placeholder path -> absolute path
  const failedPaths = new Set<string>();

  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(shotsRoot ?? ".", p);
    try {
      statSync(abs);
    } catch {
      failedPaths.add(p);
      continue;
    }
    if (mimeFor(abs) === null) {
      failedPaths.add(p);
      continue;
    }
    resolvedPaths.set(p, abs);
  }

  // Upload each file.
  const substitutionMap = new Map<string, string>();
  let endpointProven = false;

  for (const [placeholder, absPath] of resolvedPaths) {
    const mime = mimeFor(absPath)!;
    let bytes: Buffer;
    try {
      bytes = readFileSync(absPath);
    } catch (err) {
      console.error(
        `failed to read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failedPaths.add(placeholder);
      continue;
    }

    // POST to register the attachment.
    let postStatus: number;
    let postBody: unknown;
    try {
      const result = await postAttachment(apiBase, documentId, token, {
        filename: absPath.split("/").pop() ?? placeholder,
        mimeType: mime,
        sizeBytes: bytes.length,
        purpose: "inline",
      });
      postStatus = result.status;
      postBody = result.body;
    } catch (err) {
      console.error(
        `network error uploading ${placeholder}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!endpointProven) {
        return 3;
      }
      failedPaths.add(placeholder);
      continue;
    }

    if (postStatus === 404 || postStatus === 405) {
      if (!endpointProven) {
        // Abort before writing --out; caller uses original body.
        console.error(
          `attachments endpoint absent (HTTP ${postStatus}); feature not deployed`,
        );
        return 3;
      }
      failedPaths.add(placeholder);
      continue;
    }

    if (postStatus === 401 || postStatus === 403) {
      console.error(`auth failure uploading ${placeholder} (HTTP ${postStatus})`);
      return 4;
    }

    if (postStatus !== 200) {
      console.error(`unexpected status ${postStatus} uploading ${placeholder}`);
      failedPaths.add(placeholder);
      continue;
    }

    // Endpoint is now proven to exist.
    endpointProven = true;

    const attachmentData = postBody as AttachmentResponse;
    if (
      typeof attachmentData !== "object" ||
      attachmentData === null ||
      typeof attachmentData.attachmentId !== "string" ||
      typeof attachmentData.uploadUrl !== "string"
    ) {
      console.error(`unexpected response body for ${placeholder}`);
      failedPaths.add(placeholder);
      continue;
    }

    // PUT the raw bytes.
    let putStatus: number;
    try {
      const result = await putFileBytes(attachmentData.uploadUrl, bytes, mime);
      putStatus = result.status;
    } catch (err) {
      console.error(
        `network error on PUT for ${placeholder}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failedPaths.add(placeholder);
      continue;
    }

    if (putStatus < 200 || putStatus >= 300) {
      console.error(`PUT failed with status ${putStatus} for ${placeholder}`);
      failedPaths.add(placeholder);
      continue;
    }

    substitutionMap.set(placeholder, attachmentData.attachmentId);
  }

  // Build the output body.
  let outBody = substitute(body, substitutionMap);
  outBody = stripFailed(outBody, Array.from(failedPaths));

  writeFileSync(outPath, outBody, "utf-8");

  const summary: UploadSummary = {
    uploaded: substitutionMap.size,
    stripped: Array.from(failedPaths),
    documentId,
  };
  console.log(JSON.stringify(summary));
  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "document-id": { type: "string" },
      "api-base": { type: "string" },
      "body": { type: "string" },
      "out": { type: "string" },
      "shots-root": { type: "string" },
      "token-env": { type: "string", default: "CLOSEDLOOP_API_TOKEN" },
      "probe-only": { type: "boolean", default: false },
    },
  });

  const documentId = values["document-id"];
  if (!documentId) {
    console.error("error: --document-id is required");
    return 1;
  }

  const apiBase = values["api-base"];
  if (!apiBase) {
    console.error("error: --api-base is required");
    return 1;
  }

  const tokenEnv = values["token-env"] ?? "CLOSEDLOOP_API_TOKEN";
  const token = process.env[tokenEnv];
  if (!token) {
    console.error(
      `error: token missing; set ${tokenEnv} to a valid API token`,
    );
    return 4;
  }

  const probeOnly = values["probe-only"] ?? false;
  if (probeOnly) {
    return await runProbe(apiBase, documentId, token);
  }

  const bodyPath = values["body"];
  if (!bodyPath) {
    console.error("error: --body is required");
    return 1;
  }

  const outPath = values["out"];
  if (!outPath) {
    console.error("error: --out is required");
    return 1;
  }

  let body: string;
  try {
    body = readFileSync(bodyPath, "utf-8");
  } catch (err) {
    console.error(
      `error reading body file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  return await uploadImages(
    body,
    documentId,
    apiBase,
    token,
    values["shots-root"],
    outPath,
  );
}

runWhenMain(import.meta.url, main);
