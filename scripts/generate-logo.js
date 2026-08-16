'use strict';

// ============================================================
// Boomi Companion — brand asset generator (pure Node, zero deps)
// Emits:
//   assets/logo.svg   — vector mark (rounded badge + integration atom)
//   assets/logo.png   — 256x256 RGBA raster (hand-encoded PNG via zlib)
//   assets/logo.ico   — ICO container embedding the same 256x256 PNG
// Run: node scripts/generate-logo.js
// ============================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

// ---- geometry (slightly tilted "atom" / integration mark) ----
const CX = SIZE / 2;
const CY = SIZE / 2;
const CORNER_R = 56;      // rounded-badge corner radius
const RING_A = 84;        // orbital ellipse semi-major
const RING_B = 46;        // orbital ellipse semi-minor
const RING_THETA = -0.5;  // tilt (radians)
const RING_STROKE = 7;    // approx stroke width
const CORE_R = 15;        // centre node radius
const NODE_R = 9;         // orbital node radius
const NODE_ANGLES = [Math.PI / 2, (7 * Math.PI) / 6, (11 * Math.PI) / 6];

// ---- palette ----
const GRAD_TOP = [30, 74, 72];      // #1E4A48 deep teal
const GRAD_BOTTOM = [15, 23, 42];   // #0F172A slate
const RING_RGB = [94, 234, 212];    // #5EEAD4 soft aqua
const WHITE = [248, 250, 252];      // #F8FAFC
const NODE_RGB = [241, 245, 249];   // #F1F5F9

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function mix(a, b, t) { return a + (b - a) * t; }

// Vertical gradient on the rounded badge.
function bgColor(x, y) {
  const t = clamp((y / SIZE), 0, 1);
  return [mix(GRAD_TOP[0], GRAD_BOTTOM[0], t),
          mix(GRAD_TOP[1], GRAD_BOTTOM[1], t),
          mix(GRAD_TOP[2], GRAD_BOTTOM[2], t)];
}

function inRoundedRect(x, y) {
  const rx = clamp(x, CORNER_R, SIZE - CORNER_R);
  const ry = clamp(y, CORNER_R, SIZE - CORNER_R);
  const dx = x - rx;
  const dy = y - ry;
  return dx * dx + dy * dy <= CORNER_R * CORNER_R;
}

// Rotated-frame potential F = (x'/a)^2 + (y'/b)^2 ; ring band near F == 1.
function ringBand(x, y) {
  const dx = x - CX;
  const dy = y - CY;
  const c = Math.cos(RING_THETA);
  const s = Math.sin(RING_THETA);
  const xp = dx * c + dy * s;
  const yp = -dx * s + dy * c;
  const f = (xp * xp) / (RING_A * RING_A) + (yp * yp) / (RING_B * RING_B);
  // |dF| -> radial width: along the major axis dF/dr ~ 2/a, so
  // a radial stroke s corresponds to dF ~ 2*s/a. Scale for minor axis too.
  const band = (2 * RING_STROKE) / (RING_A + RING_B) * 2;
  return Math.abs(f - 1) <= band;
}

function orbitPoint(t) {
  const c = Math.cos(RING_THETA);
  const s = Math.sin(RING_THETA);
  const xp = RING_A * Math.cos(t);
  const yp = RING_B * Math.sin(t);
  return { x: CX + xp * c - yp * s, y: CY + xp * s + yp * c };
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function sample(x, y) {
  if (!inRoundedRect(x, y)) return { r: 0, g: 0, b: 0, a: 0 };
  const bg = bgColor(x, y);
  if (ringBand(x, y)) return { r: RING_RGB[0], g: RING_RGB[1], b: RING_RGB[2], a: 255 };
  for (const t of NODE_ANGLES) {
    const p = orbitPoint(t);
    if (inCircle(x, y, p.x, p.y, NODE_R)) return { r: NODE_RGB[0], g: NODE_RGB[1], b: NODE_RGB[2], a: 255 };
  }
  if (inCircle(x, y, CX, CY, CORE_R)) return { r: WHITE[0], g: WHITE[1], b: WHITE[2], a: 255 };
  return { r: bg[0], g: bg[1], b: bg[2], a: 255 };
}

// 2x2 supersampling for smooth edges.
function pixel(x, y) {
  let r = 0, g = 0, b = 0, a = 0;
  for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    const p = sample(x + ox, y + oy);
    r += p.r; g += p.g; b += p.b; a += p.a;
  }
  return { r: Math.round(r / 4), g: Math.round(g / 4), b: Math.round(b / 4), a: Math.round(a / 4) };
}

function buildPng() {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const line = Buffer.alloc(1 + SIZE * 4);
    line[0] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const p = pixel(x, y);
      const o = 1 + x * 4;
      line[o] = p.r;
      line[o + 1] = p.g;
      line[o + 2] = p.b;
      line[o + 3] = p.a;
    }
    rows.push(line);
  }
  return Buffer.concat(rows);
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function encodePng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const idat = zlib.deflateSync(buildPng(), { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type: icon
  header.writeUInt16LE(1, 4);          // count: 1 image
  const entry = Buffer.alloc(16);
  entry[0] = SIZE >= 256 ? 0 : SIZE;   // width  (0 == 256)
  entry[1] = SIZE >= 256 ? 0 : SIZE;   // height (0 == 256)
  entry[2] = 0;                        // palette
  entry[3] = 0;                        // reserved
  entry.writeUInt16LE(1, 4);           // planes
  entry.writeUInt16LE(32, 6);          // bit count
  entry.writeUInt32LE(png.length, 8);  // bytes in resource
  entry.writeUInt32LE(22, 12);         // image offset
  return Buffer.concat([header, entry, png]);
}

function buildSvg() {
  const nodes = NODE_ANGLES.map((t) => {
    const p = orbitPoint(t);
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${NODE_R}" fill="#F1F5F9"/>`;
  }).join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1E4A48"/>
      <stop offset="1" stop-color="#0F172A"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="248" height="248" rx="56" fill="url(#badge)"/>
  <g transform="rotate(${(-RING_THETA * 180 / Math.PI).toFixed(1)} 128 128)">
    <ellipse cx="128" cy="128" rx="${RING_A}" ry="${RING_B}" fill="none"
             stroke="#5EEAD4" stroke-width="${RING_STROKE}"/>
    ${nodes}
  </g>
  <circle cx="128" cy="128" r="${CORE_R}" fill="#F8FAFC"/>
</svg>
`;
}

function main() {
  const assets = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(assets, { recursive: true });

  const png = encodePng();
  const ico = encodeIco(png);
  const svg = buildSvg();

  fs.writeFileSync(path.join(assets, 'logo.svg'), svg, 'utf8');
  fs.writeFileSync(path.join(assets, 'logo.png'), png);
  fs.writeFileSync(path.join(assets, 'logo.ico'), ico);

  const sizes = `png=${png.length}B ico=${ico.length}B svg=${svg.length}B`;
  console.log(`Generated Boomi Companion brand assets in ${assets}`);
  console.log(`  ${sizes}`);
  // sanity: PNG signature + IHDR dimensions
  console.log(`  png magic ok: ${png.slice(0, 8).toString('hex') === '89504e470d0a1a0a'}`);
  console.log(`  png 256x256:  ${png.readUInt32BE(16) === 256 && png.readUInt32BE(20) === 256}`);
  console.log(`  ico count=1:  ${ico.readUInt16LE(4) === 1}`);
}

main();