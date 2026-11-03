// Exact PNG comparison for frozen-render.mjs (ISS-13317), with node built-ins
// only. Reads the 8-bit, non-interlaced RGB or RGBA PNGs Chromium screenshots
// produce and refuses anything else. The comparison has no threshold: two
// screenshots are the same only when every decoded pixel is. The cropped diff
// it writes is for a person or an agent to look at instead of the full
// screenshots, so it is downscaled to at most CROP_MAX_WIDTH; it is never
// compared.

import { createHash } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";

export const CROP_MAX_WIDTH = 800;
const CROP_MARGIN = 16;
const GUTTER = 8;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = Object.freeze({ 2: 3, 6: 4 });
const HIGHLIGHT = Object.freeze([255, 0, 64, 255]);
const WHITE = Object.freeze([255, 255, 255, 255]);

/** `{width, height, data}` with `data` as row-major RGBA bytes. */
export function decodePng(file) {
  const bytes = Buffer.from(file);
  if (!bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  let header = null;
  const idat = [];
  for (let offset = SIGNATURE.length; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = header ? CHANNELS[header.color] : undefined;
  if (!header || header.depth !== 8 || channels === undefined || header.interlace !== 0) {
    throw new Error("only 8-bit non-interlaced RGB or RGBA PNGs are read");
  }
  return { width: header.width, height: header.height, data: unfilter(inflateSync(Buffer.concat(idat)), header.width, header.height, channels) };
}

/** An RGBA image as a PNG file. */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** SHA-256 of the size and decoded pixels, so equal hashes mean every pixel matches. */
export function pixelHash(image) {
  const size = Buffer.alloc(8);
  size.writeUInt32BE(image.width, 0);
  size.writeUInt32BE(image.height, 4);
  return createHash("sha256").update(size).update(image.data).digest("hex");
}

/**
 * Every pixel that differs between two images, with no threshold. Images of
 * different sizes are compared over the larger size, a pixel only one of them
 * has counting as different.
 */
export function diffImages(before, after) {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const [a, b] = [pad(before, width, height), pad(after, width, height)];
  const diff = new Uint8Array(width * height * 4);
  let differing = 0;
  let [minX, minY, maxX, maxY] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) {
        const faded = Math.round(255 - (255 - (0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2])) * 0.2);
        diff.set([faded, faded, faded, 255], i);
        continue;
      }
      differing++;
      diff.set(HIGHLIGHT, i);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    differing, width, height,
    bounds: differing ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    images: [{ width, height, data: a }, { width, height, data: b }, { width, height, data: diff }],
  };
}

/**
 * The differing region of two PNG screenshots, with a margin, as one PNG:
 * before, after and the highlighted diff side by side, at most
 * CROP_MAX_WIDTH wide. Null when every pixel matches.
 */
export function cropDiffPng(beforePng, afterPng) {
  const result = diffImages(decodePng(beforePng), decodePng(afterPng));
  if (!result.bounds) {
    return null;
  }
  const box = padBox(result.bounds, CROP_MARGIN, result.width, result.height);
  const strip = sideBySide(result.images.map((image) => crop(image, box)));
  return { differing: result.differing, bounds: result.bounds, png: encodePng(downscale(strip, CROP_MAX_WIDTH)) };
}

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[out + x - channels] : 0;
      const up = y > 0 ? rows[out - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? rows[out - stride + x - channels] : 0;
      rows[out + x] = (line[x] + predict(filter, left, up, upLeft)) % 256;
    }
  }
  if (channels === 4) {
    return new Uint8Array(rows);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set([rows[i * 3], rows[i * 3 + 1], rows[i * 3 + 2], 255], i * 4);
  }
  return rgba;
}

function predict(filter, left, up, upLeft) {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4: {
      const estimate = left + up - upLeft;
      const [toLeft, toUp, toUpLeft] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
      if (toLeft <= toUp && toLeft <= toUpLeft) {
        return left;
      }
      return toUp <= toUpLeft ? up : upLeft;
    }
    default:
      throw new Error(`unknown PNG filter type ${filter}`);
  }
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** `image` on a transparent canvas of `width` x `height`. */
function pad(image, width, height) {
  if (image.width === width && image.height === height) {
    return image.data;
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < image.height; y++) {
    data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * width * 4);
  }
  return data;
}

function padBox(box, margin, width, height) {
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  return { x, y, width: Math.min(width, box.x + box.width + margin) - x, height: Math.min(height, box.y + box.height + margin) - y };
}

function crop(image, box) {
  const data = new Uint8Array(box.width * box.height * 4);
  for (let row = 0; row < box.height; row++) {
    const from = ((box.y + row) * image.width + box.x) * 4;
    data.set(image.data.subarray(from, from + box.width * 4), row * box.width * 4);
  }
  return { width: box.width, height: box.height, data };
}

function sideBySide(images) {
  const height = Math.max(...images.map((image) => image.height));
  const width = images.reduce((sum, image) => sum + image.width, 0) + GUTTER * (images.length - 1);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set(WHITE, i * 4);
  }
  let left = 0;
  for (const image of images) {
    for (let row = 0; row < image.height; row++) {
      data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), (row * width + left) * 4);
    }
    left += image.width + GUTTER;
  }
  return { width, height, data };
}

/** An averaged reduction to at most `maxWidth` wide, for viewing only. */
function downscale(image, maxWidth) {
  const factor = Math.ceil(image.width / maxWidth);
  if (factor <= 1) {
    return image;
  }
  const width = Math.ceil(image.width / factor);
  const height = Math.ceil(image.height / factor);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let sy = y * factor; sy < Math.min(image.height, (y + 1) * factor); sy++) {
        for (let sx = x * factor; sx < Math.min(image.width, (x + 1) * factor); sx++) {
          for (let c = 0; c < 4; c++) {
            sums[c] += image.data[(sy * image.width + sx) * 4 + c];
          }
          count++;
        }
      }
      data.set(sums.map((sum) => Math.round(sum / count)), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
