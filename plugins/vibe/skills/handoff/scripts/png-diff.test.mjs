import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { CROP_MAX_WIDTH, cropDiffPng, decodePng, diffImages, encodePng, pixelHash } from "./png-diff.mjs";

/** A PNG whose rows use the given filter types, as Chromium's encoder writes them. */
function filteredPng(width, height, channels, pixel, filters) {
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.set(pixel(x, y).slice(0, channels), y * stride + x * channels);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length];
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? rows[y * stride + i - channels] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? rows[(y - 1) * stride + i - channels] : 0;
      const estimate = left + up - upLeft;
      const predicted = [0, left, up, Math.floor((left + up) / 2),
        Math.abs(estimate - left) <= Math.abs(estimate - up) && Math.abs(estimate - left) <= Math.abs(estimate - upLeft) ? left
          : Math.abs(estimate - up) <= Math.abs(estimate - upLeft) ? up : upLeft][filter];
      raw[y * (stride + 1) + 1 + i] = (rows[y * stride + i] - predicted + 256) % 256;
    }
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const gradient = (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 91) % 256, (x * y * 13) % 256, 255];

function solid(width, height, color) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(color, i * 4);
  return { width, height, data };
}

test("RGB and RGBA PNGs decode the same pixels through every row filter", () => {
  const rgba = decodePng(filteredPng(9, 10, 4, gradient, [0, 1, 2, 3, 4]));
  const rgb = decodePng(filteredPng(9, 10, 3, gradient, [4, 3, 2, 1, 0]));
  assert.equal(pixelHash(rgba), pixelHash(rgb));
  assert.deepEqual([...rgba.data.subarray((3 * 9 + 7) * 4, (3 * 9 + 7) * 4 + 4)], gradient(7, 3));
  assert.equal(pixelHash(decodePng(encodePng(rgba))), pixelHash(rgba));
});

test("it refuses what it cannot read rather than guessing", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG file/);
  const png = Buffer.from(filteredPng(2, 2, 4, gradient, [0]));
  png[24] = 16;
  assert.throws(() => decodePng(png), /only 8-bit non-interlaced RGB or RGBA/);
});

test("one changed pixel differs with no threshold, and a size change counts the extra pixels", () => {
  const before = solid(5, 4, [10, 10, 10, 255]);
  const after = solid(5, 4, [10, 10, 10, 255]);
  after.data.set([10, 10, 11, 255], (1 * 5 + 2) * 4);
  assert.notEqual(pixelHash(before), pixelHash(after));
  assert.deepEqual(diffImages(before, after).bounds, { x: 2, y: 1, width: 1, height: 1 });
  const taller = diffImages(before, solid(5, 6, [10, 10, 10, 255]));
  assert.equal(taller.differing, 10);
  assert.deepEqual(taller.bounds, { x: 0, y: 4, width: 5, height: 2 });
  assert.equal(diffImages(before, solid(5, 4, [10, 10, 10, 255])).bounds, null);
});

test("the cropped diff covers the change, not the page, and is never wider than CROP_MAX_WIDTH", () => {
  const before = solid(3000, 400, [255, 255, 255, 255]);
  const after = solid(3000, 400, [255, 255, 255, 255]);
  for (let x = 1000; x < 1010; x++) after.data.set([0, 0, 0, 255], (200 * 3000 + x) * 4);
  const small = decodePng(cropDiffPng(encodePng(before), encodePng(after)).png);
  // 10 changed pixels plus a 16 pixel margin each side, three panels and two gutters.
  assert.deepEqual([small.width, small.height], [3 * 42 + 2 * 8, 33]);
  const wide = solid(3000, 400, [255, 255, 255, 255]);
  wide.data.set([0, 0, 0, 255], 0);
  wide.data.set([0, 0, 0, 255], (3000 - 1) * 4);
  assert.ok(decodePng(cropDiffPng(encodePng(before), encodePng(wide)).png).width <= CROP_MAX_WIDTH);
  assert.equal(cropDiffPng(encodePng(before), encodePng(before)), null);
});
