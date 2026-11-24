import { decodePng, hasPngSignature, pixelHash, pngHash } from "./png-diff.mjs";

const CONSECUTIVE_FRAMES = 3;
const MAX_STABILITY_MS = 10_000;
const PNG_OPTIONS = Object.freeze({ animations: "disabled", caret: "hide", scale: "css", fullPage: true });

/** A screenshot that cannot prove stable pixels blocks that story even if its play passed. */
export class FrozenPixelsUnsettled extends Error {
  constructor(reason, sample) {
    super(reason);
    this.sample = sample;
  }
}

function matchPixels(previous, current) {
  if (previous.png === current.png) {
    current.pixels = previous.pixels;
    return true;
  }
  previous.pixels ??= pixelHash(decodePng(previous.screenshot));
  current.pixels = pixelHash(decodePng(current.screenshot));
  return previous.pixels === current.pixels;
}

/** Preserve the play and timings already observed when screenshot acquisition could not settle. */
export function attachFrozenPlay(error, result) {
  if (error instanceof FrozenPixelsUnsettled) {
    error.render = { ...result, screenshot: error.sample?.screenshot, rawPngHash: error.sample?.png };
  }
  throw error;
}

/** Keep the last available image and both rendered facts, but never use an unstable image as comparison input. */
export function recordFrozenPixelBlock(error, { id, side, renders, save }) {
  if (error instanceof FrozenPixelsUnsettled) {
    renders[side] = error.render;
    if (error.render?.screenshot) save(error.render);
    error.block = { storyId: id, outcome: "blocking", pixelStabilityBlocked: true, reason: side + ": " + error.message,
      renders: Object.fromEntries(Object.entries(renders).map(([name, { screenshot, decodePixels, ...rest }]) => [name, rest])) };
  }
  throw error;
}

/** Only named pixel instability is a story verdict; structural capture errors still fail the gate. */
export function frozenPixelBlock(error) {
  if (error instanceof FrozenPixelsUnsettled && error.block) return error.block;
  throw error;
}

// Re-sample distinctly painted screenshots. PNG identity implies exact pixel identity; different encodings use RGBA.
async function stableScreenshot(page, timeoutMs) {
  const limit = Math.min(timeoutMs, MAX_STABILITY_MS);
  let previous, timer, expired = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new FrozenPixelsUnsettled("frozen screenshot did not stabilize within " + limit + " ms", previous));
    }, limit);
  });
  const collect = async () => {
    let consecutive = 0;
    while (!expired) {
      let screenshot;
      try {
        if (previous) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
        if (expired) break;
        screenshot = await page.screenshot(PNG_OPTIONS);
      } catch { throw new FrozenPixelsUnsettled("frozen screenshot is missing", previous); }
      if (expired) break;
      if (!hasPngSignature(screenshot)) {
        throw new FrozenPixelsUnsettled("frozen screenshot is missing or invalid", previous);
      }
      const current = { screenshot, png: pngHash(screenshot) };
      try { consecutive = previous && matchPixels(previous, current) ? consecutive + 1 : 1; }
      catch { throw new FrozenPixelsUnsettled("frozen screenshot is missing or invalid", previous); }
      previous = current;
      if (consecutive === CONSECUTIVE_FRAMES) return screenshot;
    }
  };
  try { return await Promise.race([collect(), deadline]); }
  finally { clearTimeout(timer); }
}

// Empty stories still capture, with a small bounded grace for a deferred first visual commit.
const EMPTY_ROOT_WAIT_MS = 650;

/**
 * Wait for a first foreground commit only when Storybook is still empty, cross a
 * paint boundary, then use the first strictly stable sequence of exact PNG pixels.
 */
export async function captureSettledFrozenScreenshot(page, timeoutMs) {
  await page.evaluate(async ({ limit, emptyRootWait }) => {
    const root = document.getElementById("storybook-root");
    const visible = (owner) => {
      for (let node = owner; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.matches(".sr-only, .visually-hidden, [hidden]") || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) {
          return false;
        }
        if (node === root) break;
      }
      return owner.getClientRects().length > 0;
    };
    const hasForeground = () => {
      if (!root) return true;
      const text = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (text.nextNode()) {
        const node = text.currentNode;
        if (node.textContent.trim() && node.parentElement && visible(node.parentElement)) return true;
      }
      return [...root.querySelectorAll("img,svg,canvas,video,input,textarea,select")].some(visible);
    };
    if (!hasForeground()) {
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); observer.disconnect(); resolve(); };
        const observer = new MutationObserver(() => { if (hasForeground()) finish(); });
        const timer = setTimeout(finish, Math.min(emptyRootWait, Math.floor(limit / 2)));
        observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      });
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("frozen story did not reach a painted frame within " + limit + " ms")), limit);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.fonts.ready.then(() => {
          clearTimeout(timeout);
          resolve();
        }, reject);
      }));
    });
  }, { limit: timeoutMs, emptyRootWait: EMPTY_ROOT_WAIT_MS });
  return stableScreenshot(page, timeoutMs);
}
