import path from "node:path";
import { mkdirSync } from "node:fs";

// Small controls use one band. Tall scrollers prove foreground across most of eight.
const FAR_END_BANDS = Object.freeze({ max: 8, minHeight: 24 });

/** Full and internally consistent coverage evidence for one visible scroller at its far end. */
export function validFarEndCoverage(coverage, maxHeight) {
  const { height, bands, filled } = coverage ?? {};
  return Number.isSafeInteger(height) && height > 0 && height <= maxHeight
    && bands === Math.max(1, Math.min(FAR_END_BANDS.max, Math.floor(height / FAR_END_BANDS.minHeight)))
    && Array.isArray(filled) && filled.every((band, index) => Number.isSafeInteger(band) && band >= 0
      && band < bands && (index === 0 || band > filled[index - 1]));
}

/** Most of the visible height must contain foreground, including at least one band in a short scroller. */
export function farEndCoveragePasses(coverage, maxHeight) {
  return validFarEndCoverage(coverage, maxHeight) && coverage.filled.length * 2 > coverage.bands;
}

/**
 * Browser-side probe. This function has no Node dependencies so the same Page.evaluate call
 * runs in a web page, a Storybook story or an Electron renderer.
 */
export function inspectVisualQaOverflow({ horizontalScrollers = [], verticalOnly = [] } = {}) {
  const documentElement = document.scrollingElement;
  const elements = [...document.querySelectorAll("*")];
  const styles = new Map(elements.map((element) => [element, getComputedStyle(element)]));
  const scrollable = /^(auto|scroll|overlay)$/;
  const applies = (element, selectors) => selectors.some((selector) => element.matches(selector));
  const selectorPath = (node) => {
    if (node === documentElement) return ":root";
    const parts = [];
    for (let element = node; element && element !== document.documentElement; element = element.parentElement) {
      const id = element.id && "#" + CSS.escape(element.id);
      if (id && document.querySelectorAll(id).length === 1) return [id, ...parts].join(" > ");
      const sibling = element.parentElement ? Array.from(element.parentElement.children).indexOf(element) + 1 : 1;
      parts.unshift(CSS.escape(element.localName) + ":nth-child(" + sibling + ")");
    }
    return [":root", ...parts].join(" > ");
  };
  const containerSet = new Set([documentElement, ...elements.filter((element) => {
    const { overflowX, overflowY } = styles.get(element);
    return scrollable.test(overflowX) || scrollable.test(overflowY);
  })]);
  const entries = [];
  for (const element of containerSet) {
    if (!element || element.clientWidth === 0 || element.clientHeight === 0) continue;
    const root = element === documentElement;
    const style = styles.get(element) ?? getComputedStyle(element);
    const rtl = style.direction === "rtl";
    const horizontal = (root || scrollable.test(style.overflowX)) && element.scrollWidth > element.clientWidth;
    const vertical = (root || scrollable.test(style.overflowY)) && element.scrollHeight > element.clientHeight;
    if (!horizontal && !vertical) continue;
    const rect = root ? { left: 0, top: 0, right: element.clientWidth } : element.getBoundingClientRect();
    const left = rect.left + (root ? 0 : element.clientLeft);
    const top = rect.top + (root ? 0 : element.clientTop);
    const widthEnd = rtl ? left : left + element.clientWidth;
    const heightEnd = top + element.clientHeight;
    const offset = (child) => {
      const box = child.getBoundingClientRect();
      return { child, x: (rtl ? widthEnd - box.left : box.right - widthEnd) + Math.abs(element.scrollLeft),
        y: box.bottom - heightEnd + element.scrollTop };
    };
    const descendants = root ? elements : element.querySelectorAll("*");
    const furthest = { x: null, y: null };
    for (const child of descendants) {
      if (child === element) continue;
      const extent = offset(child);
      for (const axis of ["x", "y"]) {
        if (!(axis === "x" ? horizontal : vertical) || extent[axis] <= (furthest[axis]?.[axis] ?? 0)) continue;
        // A nested scroller normally clips its own contents. An absolute descendant whose
        // containing block sits outside that clip can still expand the ancestor's scroll box.
        const absolute = styles.get(child)?.position === "absolute";
        let clipped = false;
        for (let parent = child.parentElement; parent && parent !== element; parent = parent.parentElement) {
          const overflow = styles.get(parent)?.[axis === "x" ? "overflowX" : "overflowY"];
          if (overflow && overflow !== "visible" && (!absolute || (child.offsetParent && parent.contains(child.offsetParent)))) {
            clipped = true;
            break;
          }
        }
        if (!clipped) furthest[axis] = extent;
      }
    }
    const ownWidth = Math.max(0, ...Array.from(element.children, (child) => offset(child).x));
    const horizontalLimit = element.scrollWidth - element.clientWidth;
    // Explicitly intended scrolling only accounts for width its own children provide.
    const intended = !root && !applies(element, verticalOnly) && applies(element, horizontalScrollers);
    const ownsWidth = ownWidth + 1 >= horizontalLimit && (furthest.x?.x ?? 0) <= ownWidth + 1;
    const described = (extent) => extent ? {
      path: selectorPath(extent.child),
      absolute: styles.get(extent.child)?.position === "absolute",
      visuallyHidden: Array.from(extent.child.classList).some((name) => /^(sr-only|visually-hidden)$/.test(name)),
    } : null;
    entries.push({
      path: selectorPath(element), horizontal, vertical,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      protruding: { x: described(furthest.x), y: described(furthest.y) },
      blocking: horizontal && (!intended || !ownsWidth),
    });
  }
  return { width: innerWidth, height: innerHeight, checkedContainers: containerSet.size, entries };
}

/** Reveal one container and record all offsets the operation may change. */
export function revealScrollEnd({ path: selector, horizontal, vertical, blocking, bandRecipe }) {
  // Keep the measurement inside the evaluated function so web and Electron use the same DOM boundary.
  const measure = (scroller) => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      const left = rect.left + node.clientLeft;
      const top = rect.top + node.clientTop;
      return { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight };
    };
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const intersect = (a, b, x = true, y = true) => ({
      left: x ? Math.max(a.left, b.left) : a.left,
      right: x ? Math.min(a.right, b.right) : a.right,
      top: y ? Math.max(a.top, b.top) : a.top,
      bottom: y ? Math.min(a.bottom, b.bottom) : a.bottom,
    });
    const styles = new Map();
    const styleOf = (node) => {
      if (!styles.has(node)) styles.set(node, getComputedStyle(node));
      return styles.get(node);
    };
    const clip = (node, area) => {
      const style = styleOf(node);
      return intersect(area, box(node), style.overflowX !== "visible", style.overflowY !== "visible");
    };
    let visible = intersect(viewport, box(scroller));
    for (let ancestor = scroller.parentElement; ancestor; ancestor = ancestor.parentElement) visible = clip(ancestor, visible);
    const height = Math.max(0, Math.floor(visible.bottom - visible.top));
    const bands = Math.max(1, Math.min(bandRecipe.max, Math.floor(height / bandRecipe.minHeight)));
    const filled = new Set();
    if (height === 0 || visible.right <= visible.left) return { height, bands, filled: [] };
    const bandSize = height / bands;
    const foreground = (owner, rect) => {
      let bounds = intersect(visible, rect);
      for (let node = owner; node && node !== scroller; node = node.parentElement) {
        const style = styleOf(node);
        if (style.visibility !== "visible" || Number(style.opacity) === 0
          || ["sticky", "fixed"].includes(style.position) || node.matches(".sr-only, .visually-hidden")) return;
        if (node !== owner) bounds = clip(node, bounds);
      }
      if (bounds.right - bounds.left < 2 || bounds.bottom <= bounds.top) return;
      for (let band = 0; band < bands; band += 1) {
        if (filled.has(band)) continue;
        const top = Math.max(bounds.top, visible.top + band * bandSize);
        const bottom = Math.min(bounds.bottom, visible.top + (band + 1) * bandSize);
        if (bottom - top < Math.min(2, bandSize)) continue;
        const y = (top + bottom) / 2;
        const x = (bounds.left + bounds.right) / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === owner || owner.contains(hit))) filled.add(band);
      }
    };
    const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (filled.size < bands && walker.nextNode()) {
      const text = walker.currentNode;
      const owner = text.parentElement;
      if (!owner || !text.textContent.trim() || /^(?:transparent|rgba\(.+, 0\))$/.test(styleOf(owner).color)) continue;
      range.selectNodeContents(text);
      for (const rect of range.getClientRects()) foreground(owner, rect);
    }
    // Replaced media and editable controls have visible content without a text range.
    for (const media of scroller.querySelectorAll("img, video, canvas, svg, input:not([type=hidden]), select, textarea")) {
      if (filled.size === bands) break;
      if (media.localName === "img" && !media.naturalWidth) continue;
      if (media.localName === "video" && media.readyState < 2) continue;
      if (media.localName === "svg" && !media.getBBox().width) continue;
      foreground(media, media.getBoundingClientRect());
    }
    return { height, bands, filled: Array.from({ length: bands }, (_, band) => band).filter((band) => filled.has(band)) };
  };
  const element = selector === ":root" ? document.scrollingElement : document.querySelector(selector);
  if (!element) throw new Error("scroll container changed before capture: " + selector);
  const offsets = [];
  for (let node = element; node; node = node.parentElement) {
    offsets.push({ x: node.scrollLeft, y: node.scrollTop });
  }
  if (element !== document.scrollingElement) element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const rtl = getComputedStyle(element).direction === "rtl";
  element.scrollTo({ left: horizontal ? (rtl ? -element.scrollWidth : element.scrollWidth) : element.scrollLeft,
    top: vertical ? element.scrollHeight : element.scrollTop, behavior: "instant" });
  const reached = (!horizontal || Math.abs(element.scrollLeft) + 1 >= element.scrollWidth - element.clientWidth)
    && (!vertical || element.scrollTop + 1 >= element.scrollHeight - element.clientHeight);
  let farEndCoverage;
  if (reached && horizontal && !blocking) {
    try { farEndCoverage = measure(element); }
    catch { farEndCoverage = null; } // Incomplete evidence still returns offsets for restoration.
  }
  return { offsets, reached, farEndCoverage };
}

/** Restore inner and outer scroll positions even if the screenshot failed. */
function restoreScrollOffsets({ path: selector, offsets }) {
  let node = selector === ":root" ? document.scrollingElement : document.querySelector(selector);
  for (const { x, y } of offsets) {
    if (!node) break;
    node.scrollTo({ left: x, top: y, behavior: "instant" });
    node = node.parentElement;
  }
}

/**
 * Capture one settled viewport through its existing Playwright Page. The caller owns the
 * headless web or displayless Electron process, navigation, and exact source-bound QA round.
 */
export async function captureVisualQaViewport(page, { evidenceDir, name, capture, horizontalScrollers, verticalOnly }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name ?? "") || !path.isAbsolute(evidenceDir ?? "")) {
    throw new Error("visual QA capture needs an absolute evidence directory and a unique artifact name");
  }
  mkdirSync(evidenceDir, { recursive: true });
  const overflow = await page.evaluate(inspectVisualQaOverflow, { horizontalScrollers, verticalOnly });
  const viewport = overflow.width + "x" + overflow.height;
  if (capture?.viewport && capture.viewport !== viewport) throw new Error("visual QA viewport differs from the captured page");
  const png = name + ".png";
  await page.screenshot({ path: path.join(evidenceDir, png) });
  for (const [index, entry] of overflow.entries.entries()) {
    const end = await page.evaluate(revealScrollEnd, { ...entry, bandRecipe: FAR_END_BANDS });
    try {
      if (!end.reached) throw new Error("scroll container did not reach its far end: " + entry.path);
      if (entry.horizontal && !entry.blocking) {
        entry.farEndCoverage = end.farEndCoverage ?? null;
        entry.blocking = !farEndCoveragePasses(entry.farEndCoverage, Math.min(overflow.height, entry.clientHeight));
      }
      entry.farEndPng = name + "-scroll-" + (index + 1) + ".png";
      await page.screenshot({ path: path.join(evidenceDir, entry.farEndPng) });
    } finally {
      await page.evaluate(restoreScrollOffsets, { path: entry.path, offsets: end.offsets });
    }
  }
  return { ...capture, viewport, png, overflow };
}
