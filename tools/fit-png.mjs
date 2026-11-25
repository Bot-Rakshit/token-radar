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
function encode(level, strategy) {
  const idat = deflateSync(raw, { level, strategy });
  const body = [];
  let wrote = false;
  for (const [t, d] of parts) {
    if (t === 'IDAT') { if (!wrote) body.push(chunk('IDAT', idat)); wrote = true; } else body.push(chunk(t, d));
  }
  return Buffer.concat([png.subarray(0, 8), ...body]);
}
if (png.length >= min && png.length <= max) { console.log(`${file}: ${png.length} bytes, already in range`); process.exit(0); }
const tries = [];
for (let level = 9; level >= 1; level--) for (const strategy of [0, 1, 3]) tries.push(encode(level, strategy));
const fit = tries.filter((b) => b.length >= min && b.length <= max).sort((a, b) => a.length - b.length)[0];
if (!fit) { console.error(`${file}: no level lands in ${min}..${max} (sizes ${[...new Set(tries.map((b) => b.length))].sort((a, b) => a - b).join(', ')})`); process.exit(1); }
if (!inflateSync(Buffer.concat(chunks(fit).filter(([t]) => t === 'IDAT').map(([, d]) => d))).equals(raw)) throw new Error('pixels changed');
writeFileSync(file, fit);
console.log(`${file}: ${png.length} -> ${fit.length} bytes, same pixels`);
