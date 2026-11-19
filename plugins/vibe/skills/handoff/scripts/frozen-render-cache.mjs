// A per-story cache of frozen-render's first base render. A base render depends only on what the base Storybook
// serves for that story and on the machine that rendered it, so its key covers both:
//   the story's base inputs   frozen-render.mjs's frozenBaseInputDigests: every file in the story's base import
//                             closure, every global render input at the base, and the head story text prepare-base
//                             overlaid
//   the rendering machine     Chromium's version, OS, release and architecture, the installed fonts
//   the render settings       viewport, --now, timeout and the renderer's own source
// The comparison has zero tolerance, so a hit is reused only on the same machine setup; anything else misses. A
// story's import closure and the global inputs are what the frozen-render rule itself counts as rendered, so the key
// misses a render input only where that rule would also miss it.
// A cached render carries the play outcome, the raw PNG hash and the screenshot; frozen-render.mjs still renders the
// base again when the branch differs, and its confirmation renders as before.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bumped when a cached entry's shape changes. */
export const CACHE_FORMAT = 1;
const SAFE_NAME = /[^a-z0-9-]+/gi;
const FONT_DIRECTORIES = Object.freeze({
  darwin: ["/System/Library/Fonts", "/Library/Fonts", path.join(homedir(), "Library", "Fonts")],
  linux: ["/usr/share/fonts", "/usr/local/share/fonts", path.join(homedir(), ".fonts"), path.join(homedir(), ".local", "share", "fonts")],
  win32: [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts")],
});
const RENDERER_SOURCES = ["frozen-render.mjs", "frozen-render-base.mjs", "png-diff.mjs", "../../vibe/scripts/story-play-verdict.mjs"]
  .map((file) => fileURLToPath(new URL(file, import.meta.url)));

/** The default cache directory: `$XDG_CACHE_HOME/vibe/frozen-render`, else `~/.cache/vibe/frozen-render`. */
export function defaultCacheDir(env = process.env) {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "vibe", "frozen-render");
}

/** A digest of every installed font file's path, size and modification time. */
export function fontsDigest(directories = FONT_DIRECTORIES[platform()] ?? []) {
  const hash = createHash("sha256");
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    // One directory's entry names are unique, so their code-unit order is a total order.
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    for (const entry of [...byName.keys()].sort().map((name) => byName.get(name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = statSync(full);
        hash.update(`${full}\0${stat.size}\0${stat.mtimeMs}\n`);
      }
    }
  };
  for (const directory of directories) walk(directory);
  return hash.digest("hex");
}

/** The machine and settings half of every key in one run. */
export function environmentDigest({ chromiumVersion, viewport, now, timeoutMs, fonts = fontsDigest(), sources = RENDERER_SOURCES }) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ format: CACHE_FORMAT, chromiumVersion, os: [platform(), release(), arch()], fonts, viewport, now, timeoutMs }));
  for (const source of sources) hash.update(readFileSync(source));
  return hash.digest("hex");
}

/**
 * A cache under `dir` for one run's environment. `get(id, inputs)` returns a cached base render or null; `set`
 * stores one. Entries are written to a temporary name and renamed, so a reader never sees half of one.
 */
export function baseRenderCache(dir, environment) {
  const fileOf = (id, inputs) => {
    const key = createHash("sha256").update(`${environment}\0${inputs}\0${id}`).digest("hex");
    return path.join(dir, key.slice(0, 2), `${key}-${id.replace(SAFE_NAME, "-").slice(0, 80)}`);
  };
  return {
    get(id, inputs) {
      const file = fileOf(id, inputs);
      if (!existsSync(`${file}.json`) || !existsSync(`${file}.png`)) return null;
      try {
        const entry = JSON.parse(readFileSync(`${file}.json`, "utf8"));
        const screenshot = readFileSync(`${file}.png`);
        if (entry.format !== CACHE_FORMAT || entry.storyId !== id || createHash("sha256").update(screenshot).digest("hex") !== entry.screenshotSha256) return null;
        return { ...entry.render, screenshot };
      } catch {
        return null;
      }
    },
    set(id, inputs, render) {
      const file = fileOf(id, inputs);
      mkdirSync(path.dirname(file), { recursive: true });
      const suffix = `.${process.pid}-${Date.now()}`;
      const { verdict, reason, failure, rawPngHash, events } = render;
      writeFileSync(`${file}.png${suffix}`, render.screenshot);
      writeFileSync(`${file}.json${suffix}`, `${JSON.stringify({ format: CACHE_FORMAT, storyId: id,
        screenshotSha256: createHash("sha256").update(render.screenshot).digest("hex"), render: { verdict, reason, failure, rawPngHash, events } })}\n`);
      renameSync(`${file}.png${suffix}`, `${file}.png`);
      renameSync(`${file}.json${suffix}`, `${file}.json`);
    },
  };
}
