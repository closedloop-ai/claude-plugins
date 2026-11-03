import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/** Where `reference-images.mjs` stores the person's visual references, beside the session record. */
export const REFERENCE_DIR = "vibe-reference-images";

const referenceSchema = z.object({
  path: z.string().min(1), mediaType: z.string().regex(/^image\/[a-z+.-]+$/),
  requestId: z.string().optional(),
}).passthrough();
const recordSchema = z.object({ referenceImages: z.array(z.unknown()).optional() }).passthrough();

export type ReferenceImage = { path: string; mediaType: string; requestId?: string };

/**
 * The reference images recorded on the session, so every writer turn names
 * them and the writer opens each as an image (operator ruling, 2026-10-15:
 * the person's screenshot never reached the writer). Only files the script
 * stored in this session's private directory are returned; a malformed or
 * missing entry is left out rather than passed on.
 */
export function readReferenceImages(metadataDir: string): ReferenceImage[] {
  const file = join(metadataDir, "vibe-session.json");
  if (!existsSync(file)) return [];
  const record = recordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!record.success) return [];
  const owned = join(metadataDir, REFERENCE_DIR);
  const images: ReferenceImage[] = [];
  for (const raw of record.data.referenceImages ?? []) {
    const entry = referenceSchema.safeParse(raw);
    if (!entry.success) continue;
    const path = resolve(entry.data.path);
    if (dirname(path) !== owned || !existsSync(path) || !statSync(path).isFile()) continue;
    images.push({ path, mediaType: entry.data.mediaType, ...(entry.data.requestId ? { requestId: entry.data.requestId } : {}) });
  }
  return images;
}
