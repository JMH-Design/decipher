/**
 * Render `media/icon-marketplace.svg` to `media/icon.png` for the Marketplace listing.
 *
 * macOS ships no SVG rasteriser on the command line except Quick Look, and Quick Look pads its
 * thumbnails with transparent margin, so this trims back to the artwork's own bounds and
 * downsamples with a box filter. Run it only when the icon changes:
 *
 *   node scripts/buildIcon.mjs
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const media = path.join(import.meta.dirname, '..', 'media');
const source = path.join(media, 'icon-marketplace.svg');
const target = path.join(media, 'icon.png');
const RENDER_SIZE = 1024;
const OUTPUT_SIZE = 256;

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decipher-icon-'));
  try {
    execFileSync('qlmanage', ['-t', '-s', String(RENDER_SIZE), '-o', tmp, source], { stdio: 'ignore' });
    const image = decodePng(fs.readFileSync(path.join(tmp, `${path.basename(source)}.png`)));
    const box = artworkBounds(image);
    fs.writeFileSync(target, encodePng(downsample(crop(image, box), OUTPUT_SIZE)));
    console.log(`[decipher] icon.png written at ${OUTPUT_SIZE}px from a ${box.size}px crop`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Minimal RGBA PNG reader: enough for what Quick Look produces (8-bit, non-interlaced). */
function decodePng(buf) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const chunks = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Expected an 8-bit, non-interlaced PNG');
    }
    if (type === 'IDAT') chunks.push(data);
    offset += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const pixels = Buffer.alloc(height * stride);

  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = raw.subarray(read, read + stride);
    read += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      pixels[y * stride + x] = (line[x] + unfilter(filter, left, up, upLeft)) & 0xff;
    }
  }

  return toRgba({ width, height, channels, stride, pixels });
}

function unfilter(filter, left, up, upLeft) {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    default: {
      const dLeft = Math.abs(up - upLeft);
      const dUp = Math.abs(left - upLeft);
      const dDiag = Math.abs(left + up - 2 * upLeft);
      return dLeft <= dUp && dLeft <= dDiag ? left : dUp <= dDiag ? up : upLeft;
    }
  }
}

function toRgba({ width, height, channels, stride, pixels }) {
  if (channels === 4) return { width, height, pixels };
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * channels;
      const to = (y * width + x) * 4;
      const grey = channels <= 2;
      out[to] = pixels[from];
      out[to + 1] = grey ? pixels[from] : pixels[from + 1];
      out[to + 2] = grey ? pixels[from] : pixels[from + 2];
      out[to + 3] = channels === 2 ? pixels[from + 1] : 255;
    }
  }
  return { width, height, pixels: out };
}

/** How far a channel must move from the padding colour to count as artwork. */
const PADDING_TOLERANCE = 24;

/**
 * The square covering the artwork. Quick Look pads its thumbnails and fills the padding with
 * an opaque backdrop, so alpha alone cannot find the edges — the top-left pixel sits outside
 * the icon's rounded corner and is a reliable sample of whatever that backdrop is.
 */
function artworkBounds({ width, height, pixels }) {
  const bg = [pixels[0], pixels[1], pixels[2], pixels[3]];
  const isPadding = (i) => Math.abs(pixels[i] - bg[0]) + Math.abs(pixels[i + 1] - bg[1]) + Math.abs(pixels[i + 2] - bg[2]) + Math.abs(pixels[i + 3] - bg[3]) <= PADDING_TOLERANCE;

  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isPadding((y * width + x) * 4)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('Quick Look produced a blank image');
  // The rounded corners are padding-coloured, so grow the box back out to the full tile.
  const size = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  return { x0: Math.max(0, Math.min(x0, x1 + 1 - size)), y0: Math.max(0, Math.min(y0, y1 + 1 - size)), size };
}

function crop({ width, pixels }, { x0, y0, size }) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    pixels.copy(out, y * size * 4, ((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + size) * 4);
  }
  return { width: size, height: size, pixels: out };
}

/** Box filter, averaging in premultiplied alpha so transparent edges do not darken. */
function downsample({ width, pixels }, size) {
  const factor = width / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = Math.floor(y * factor); sy < Math.floor((y + 1) * factor); sy++) {
        for (let sx = Math.floor(x * factor); sx < Math.floor((x + 1) * factor); sx++) {
          const i = (sy * width + sx) * 4;
          const alpha = pixels[i + 3] / 255;
          r += pixels[i] * alpha;
          g += pixels[i + 1] * alpha;
          b += pixels[i + 2] * alpha;
          a += pixels[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      const meanAlpha = a / n / 255;
      out[o] = meanAlpha ? Math.round(r / n / meanAlpha) : 0;
      out[o + 1] = meanAlpha ? Math.round(g / n / meanAlpha) : 0;
      out[o + 2] = meanAlpha ? Math.round(b / n / meanAlpha) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: size, height: size, pixels: out };
}

function encodePng({ width, height, pixels }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

main();
