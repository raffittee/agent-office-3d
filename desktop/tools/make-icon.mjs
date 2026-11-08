// Draws the app icon, the tray icons and the taskbar badge into desktop/assets/ (original artwork, generated here so
// there is nothing third-party to license). Plain Node, no dependencies:  node desktop/tools/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const SS = 4; // supersampling per axis

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function inPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const roundRect = (r) => (x, y) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const poly = (pts) => (x, y) => inPoly(pts, x, y);

/** Layers painted in order: [test(x, y) in 0..1, '#rrggbb']. */
function layers({ background, alert }) {
  const c = [0.5, 0.53];
  const R = 0.3;
  const p = (deg) => [c[0] + R * Math.cos((deg * Math.PI) / 180), c[1] + R * Math.sin((deg * Math.PI) / 180)];
  const [top, ur, lr, bottom, ll, ul] = [-90, -30, 30, 90, 150, 210].map(p);
  const out = [];
  if (background) out.push([roundRect(0.22), '#1f2937']);
  out.push([poly([top, ur, c, ul]), '#7dd3fc'], [poly([c, ur, lr, bottom]), '#0ea5e9'], [poly([c, bottom, ll, ul]), '#0369a1']);
  out.push([circle(0.5, c[1] - R * 0.5, 0.05), '#fbbf24']);
  if (alert) out.push([circle(0.76, 0.24, 0.215), '#ffffff'], [circle(0.76, 0.24, 0.17), '#ef4444']);
  return out;
}

function render(size, spec) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          let color = null;
          for (const [test, col] of spec) if (test(u, v)) color = col;
          if (color) {
            const [r, g, b] = hex(color);
            acc[0] += r;
            acc[1] += g;
            acc[2] += b;
            cover++;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (cover) {
        px[i] = Math.round(acc[0] / cover);
        px[i + 1] = Math.round(acc[1] / cover);
        px[i + 2] = Math.round(acc[2] / cover);
        px[i + 3] = Math.round((255 * cover) / (SS * SS));
      }
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A Windows .ico made of PNG images (supported since Windows Vista): the app icon in the sizes Windows asks for. */
function ico(sizes, spec) {
  const images = sizes.map((size) => png(size, render(size, spec)));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; // 0 means 256
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

mkdirSync(OUT, { recursive: true });
const files = {
  'icon.png': [512, layers({ background: true })],
  'tray.png': [32, layers({ background: true })],
  'tray-alert.png': [32, layers({ background: true, alert: true })],
  'overlay.png': [16, [[circle(0.5, 0.5, 0.5), '#ffffff'], [circle(0.5, 0.5, 0.38), '#ef4444']]],
};
for (const [name, [size, spec]] of Object.entries(files)) {
  writeFileSync(join(OUT, name), png(size, render(size, spec)));
  console.log(`wrote desktop/assets/${name} (${size}x${size})`);
}
writeFileSync(join(OUT, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256], layers({ background: true })));
console.log('wrote desktop/assets/icon.ico (16 to 256)');
