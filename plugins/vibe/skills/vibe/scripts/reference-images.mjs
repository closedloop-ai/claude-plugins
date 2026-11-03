#!/usr/bin/env node
// Saves the visual references a person gives a vibe session as image files in
// the session's private Git metadata and records them on the session record
// (operator ruling, 2026-10-15: the writer never saw the screenshot the person
// attached). The orchestrator talks to the person; the persistent writer is a
// separate context that receives text, so an image attached in chat reaches it
// only as a saved file it opens itself.
//
// Usage:
//   reference-images.mjs save     --worktree <wt> --file <image> [--request-id <id>]
//   reference-images.mjs attached --worktree <wt> [--transcript <jsonl>] [--request-id <id>] [--all]
//   reference-images.mjs list     --worktree <wt>
//
// `save` copies an image file the person gave by path (or a capture of a
// reference link). `attached` decodes the images the person attached to their
// latest chat message (`--all`: every message) from this harness's own
// transcript: the Codex rollout for CODEX_THREAD_ID, or the Claude Code
// transcript for CLAUDE_CODE_SESSION_ID; `--transcript` names the file.
// Files are content-addressed, so saving the same image twice records it once.
// Every command prints one JSON object on stdout; errors print
// {"ok":false,"error":...} and exit non-zero.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { git, readSessionRecord, writeSessionRecord } from "./session-record.mjs";

export const REFERENCE_DIR = "vibe-reference-images";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCES = 50;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const DATA_URL = /^data:(image\/[a-z+.-]+);base64,(.+)$/s;
const SIGNATURES = [
  { mediaType: "image/png", extension: "png", matches: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { mediaType: "image/jpeg", extension: "jpg", matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: "image/gif", extension: "gif", matches: (b) => b.length > 6 && b.toString("ascii", 0, 4) === "GIF8" },
  { mediaType: "image/webp", extension: "webp",
    matches: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
];

/** Every recorded reference image whose file still exists, oldest first. */
export function readReferenceImages(worktree) {
  const record = readSessionRecord(worktree);
  if (!record) {
    throw new Error("No vibe session record in this worktree.");
  }
  const dir = referenceDir(worktree);
  return (record.referenceImages ?? []).filter((entry) => isOwnedFile(dir, entry.path));
}

/** Validates, stores and records one image; the same bytes are recorded once. */
export function saveReferenceImage(worktree, bytes, { source, requestId }) {
  const record = readSessionRecord(worktree);
  if (!record) {
    throw new Error("No vibe session record in this worktree; save references once the session exists.");
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`A reference image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
  }
  const kind = SIGNATURES.find((signature) => signature.matches(bytes));
  if (!kind) {
    throw new Error("Not a PNG, JPEG, GIF or WebP image.");
  }
  if (requestId !== undefined && !REQUEST_ID.test(requestId)) {
    throw new Error("--request-id must be a plain identifier.");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = (record.referenceImages ?? []).find((entry) => entry.sha256 === sha256);
  const dir = referenceDir(worktree);
  if (existing && isOwnedFile(dir, existing.path)) {
    return { entry: existing, saved: false };
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${sha256.slice(0, 16)}.${kind.extension}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  chmodSync(file, 0o600);
  const entry = {
    path: file, sha256, mediaType: kind.mediaType, bytes: bytes.length, source,
    ...(requestId ? { requestId } : {}), savedAt: new Date().toISOString(),
  };
  const kept = (record.referenceImages ?? []).filter((item) => item.sha256 !== sha256);
  if (kept.length >= MAX_REFERENCES) {
    throw new Error(`The session already records ${MAX_REFERENCES} reference images.`);
  }
  writeSessionRecord(worktree, { ...record, referenceImages: [...kept, entry], lastActiveAt: entry.savedAt });
  return { entry, saved: true };
}

/**
 * The images in each person-authored message of a Claude Code transcript or a
 * Codex rollout, in order. Tool results (screenshots a tool took) are not the
 * person's attachments and are skipped.
 */
export function attachedImageGroups(transcriptText) {
  const groups = [];
  for (const line of transcriptText.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const images = claudeUserImages(item) ?? codexUserImages(item);
    if (images?.length) {
      groups.push(images);
    }
  }
  return groups;
}

/** The current harness's own transcript file, from its session or thread id. */
export function findTranscript(env = process.env) {
  if (env.CODEX_THREAD_ID) {
    const codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const found = findFile(path.join(codexHome, "sessions"), (name) =>
      name.startsWith("rollout-") && name.endsWith(`${env.CODEX_THREAD_ID}.jsonl`), 4);
    if (found) {
      return found;
    }
  }
  if (env.CLAUDE_CODE_SESSION_ID) {
    const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const found = findFile(path.join(claudeHome, "projects"), (name) => name === `${env.CLAUDE_CODE_SESSION_ID}.jsonl`, 1);
    if (found) {
      return found;
    }
  }
  throw new Error("No transcript found for this harness session; pass --transcript.");
}

function claudeUserImages(item) {
  if (item?.type !== "user" || item.toolUseResult !== undefined || !Array.isArray(item.message?.content)) {
    return undefined;
  }
  return item.message.content
    .filter((part) => part?.type === "image" && part.source?.type === "base64" && typeof part.source.data === "string")
    .map((part) => ({ data: part.source.data }));
}

function codexUserImages(item) {
  const payload = item?.payload;
  if (item?.type === "response_item" && payload?.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
    return payload.content
      .filter((part) => part?.type === "input_image" && typeof part.image_url === "string")
      .map((part) => dataUrlImage(part.image_url))
      .filter(Boolean);
  }
  if (item?.type === "event_msg" && payload?.type === "user_message") {
    const inline = (payload.images ?? []).filter((url) => typeof url === "string").map(dataUrlImage).filter(Boolean);
    const local = (payload.local_images ?? [])
      .map((entry) => (typeof entry === "string" ? entry : entry?.path))
      .filter((file) => typeof file === "string" && path.isAbsolute(file))
      .map((file) => ({ file }));
    return [...inline, ...local];
  }
  return undefined;
}

function dataUrlImage(url) {
  const match = DATA_URL.exec(url);
  return match ? { data: match[2] } : undefined;
}

function imageBytes(image) {
  return image.file ? readFileSync(image.file) : Buffer.from(image.data, "base64");
}

function findFile(root, matches, depth) {
  if (!existsSync(root)) {
    return undefined;
  }
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && matches(entry.name)) {
      return full;
    }
  }
  if (depth === 0) {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findFile(path.join(root, entry.name), matches, depth - 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function referenceDir(worktree) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), REFERENCE_DIR);
}

function isOwnedFile(dir, file) {
  return typeof file === "string" && path.dirname(path.resolve(file)) === dir && existsSync(file) && statSync(file).isFile();
}

function run(command, values) {
  const worktree = values.worktree;
  if (!worktree) {
    throw new Error("--worktree is required.");
  }
  if (command === "list") {
    return { referenceImages: readReferenceImages(worktree) };
  }
  if (command === "save") {
    if (!values.file) {
      throw new Error("--file is required.");
    }
    const result = saveReferenceImage(worktree, readFileSync(values.file), { source: "file", requestId: values["request-id"] });
    return { saved: [result.entry], referenceImages: readReferenceImages(worktree) };
  }
  if (command === "attached") {
    const transcript = values.transcript ?? findTranscript();
    const groups = attachedImageGroups(readFileSync(transcript, "utf8"));
    if (groups.length === 0) {
      throw new Error("The transcript has no image the person attached.");
    }
    const images = values.all ? groups.flat() : groups.at(-1);
    const saved = images.map((image) =>
      saveReferenceImage(worktree, imageBytes(image), { source: "attachment", requestId: values["request-id"] }).entry);
    return { saved, referenceImages: readReferenceImages(worktree) };
  }
  throw new Error("Unknown command. Use one of: save, attached, list.");
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      worktree: { type: "string" },
      file: { type: "string" },
      transcript: { type: "string" },
      "request-id": { type: "string" },
      all: { type: "boolean", default: false },
    },
  });
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...run(positionals[0], values) }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}
