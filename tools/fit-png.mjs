// Re-encodes a PNG losslessly (same pixels) at the zlib level that lands its size in a byte window.
// The rules ask for screenshots of 300 to 350 KB (307,200 to 350,000 bytes satisfies either reading of KB); Chrome's own encoder picks its level by speed.
//   node tools/fit-png.mjs <file.png> [min_bytes] [max_bytes]
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

const [file, minArg = '307200', maxArg = '350000'] = process.argv.slice(2);
const png = readFileSync(file);
const min = Number(minArg), max = Number(maxArg);

/** The PNG's chunks as [type, data] pairs. */
function chunks(buf) {
  const out = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    out.push([type, buf.subarray(at + 8, at + 8 + len)]);
    at += 12 + len;
  }
  return out;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const parts = chunks(png);
const raw = inflateSync(Buffer.concat(parts.filter(([t]) => t === 'IDAT').map(([, d]) => d)));

// The scanlines' filters can be chosen again: unfilter to pixels, then refilter one way for every row.
const ihdr = parts.find(([t]) => t === 'IHDR')[1];
const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), bpp = { 2: 3, 6: 4 }[ihdr[9]];
if (ihdr[8] !== 8 || !bpp || ihdr[12] !== 0) throw new Error('only 8-bit RGB or RGBA, non-interlaced');
const stride = width * bpp;
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
const pixels = Buffer.alloc(height * stride);
for (let y = 0; y < height; y++) {
  const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? pixels[row + i - bpp] : 0, b = y > 0 ? pixels[prev + i] : 0, c = y > 0 && i >= bpp ? pixels[prev + i - bpp] : 0;
    const x = raw[src + i];
    pixels[row + i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 255;
  }
}
function refilter(f) {
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1), row = y * stride, prev = row - stride;
    out[dst] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? pixels[row + i - bpp] : 0, b = y > 0 ? pixels[prev + i] : 0, c = y > 0 && i >= bpp ? pixels[prev + i - bpp] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[dst + 1 + i] = (pixels[row + i] - pred) & 255;
    }
  }
  return out;
}
const streams = [raw, ...[0, 1, 2, 3, 4].map(refilter)];
function encode(level, strategy, stream) {
  const idat = deflateSync(stream, { level, strategy });
  const body = [];
  let wrote = false;
  for (const [t, d] of parts) {
    if (t === 'IDAT') { if (!wrote) body.push(chunk('IDAT', idat)); wrote = true; } else body.push(chunk(t, d));
  }
  return Buffer.concat([png.subarray(0, 8), ...body]);
}
if (png.length >= min && png.length <= max) { console.log(`${file}: ${png.length} bytes, already in range`); process.exit(0); }
const tries = [];
for (const stream of streams) for (let level = 9; level >= 1; level -= 2) for (const strategy of [0, 1]) tries.push(encode(level, strategy, stream));
const fit = tries.filter((b) => b.length >= min && b.length <= max).sort((a, b) => a.length - b.length)[0];
if (!fit) { console.error(`${file}: no level lands in ${min}..${max} (sizes ${[...new Set(tries.map((b) => b.length))].sort((a, b) => a - b).join(', ')})`); process.exit(1); }
// Never trust the encoder: decode the chosen file back and compare every pixel.
const back = inflateSync(Buffer.concat(chunks(fit).filter(([t]) => t === 'IDAT').map(([, d]) => d)));
for (let y = 0; y < height; y++) {
  const f = back[y * (stride + 1)], row = y * stride;
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? pixels[row + i - bpp] : 0, b = y > 0 ? pixels[row - stride + i] : 0, c = y > 0 && i >= bpp ? pixels[row - stride + i - bpp] : 0;
    const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
    if (((back[y * (stride + 1) + 1 + i] + pred) & 255) !== pixels[row + i]) throw new Error('pixels changed');
  }
}
writeFileSync(file, fit);
console.log(`${file}: ${png.length} -> ${fit.length} bytes, same pixels`);
