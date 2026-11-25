// Token Radar, a token-radar-01 entry. Node 22, standard library only, no network.
//
// main.ts is the runner, not the model. The model lives in dashboard/1-model.js (values) and 2-farm.js (plans), plain scripts that the
// page loads in the browser and that this file loads in Node, so board.json and the page are computed by
// the very same functions: there is one model, and the judge reads it whole in the dashboard source.
//
//   1. read the sealed snapshot (/input/snapshot.json, or --input <file|dir>)
//   2. run RadarModel.buildRadar(snapshot): peer calibration, the pre-token screen, values, farm plans
//   3. check the board against the gate's rules before writing a byte (checkBoard below)
//   4. write /output/board.json, /output/data.js (the snapshot plus board.json's values, for the page's
//      parity check), copy dashboard/ and screenshots/, and write dossier.json last with buildDossier
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const RadarModel = createRequire(import.meta.url)('./dashboard/1-model.js');

const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|dir> or mount /input`, 2);
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

interface GateRow { rank: number; slug: string; name: string; implied_value_usd: number; farm_steps: string[] }

/** The gate's board rules, checked here so a bad board is never written: null when the board passes. */
function checkBoard(rows: GateRow[], snapshot: { protocols: { slug: string }[]; watchlist: string[] }): string | null {
  if (rows.length < 100 || rows.length > 4000) return `${rows.length} rows, the gate takes 100 to 4,000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    if (!known.has(r.slug)) return `row ${i}: ${r.slug} is not a snapshot protocol`;
    if (seen.has(r.slug)) return `row ${i}: ${r.slug} appears twice`;
    seen.add(r.slug);
    if (/\s/.test(r.slug) || r.slug.length > 128) return `row ${i}: bad slug ${r.slug}`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `row ${i}: empty name`;
    if (r.rank !== i + 1) return `row ${i}: rank ${r.rank}, expected ${i + 1}`;
    const v = r.implied_value_usd;
    if (!Number.isSafeInteger(v) || v < 1 || v > 1e14) return `row ${i}: implied value ${v} is not a whole dollar figure in range`;
    if (i > 0 && v > rows[i - 1]!.implied_value_usd) return `row ${i}: implied value rises as rank ascends`;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${i}: ${r.farm_steps?.length} farm steps`;
    for (const s of r.farm_steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) return `row ${i}: a farm step of ${n} characters`;
    }
  }
  if (new Set(rows.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `watchlist slugs missing: ${missing.join(', ')}`;
  return null;
}

const snapshotText = readFileSync(inputFile, 'utf8');
const snapshot = JSON.parse(snapshotText);
const radar = RadarModel.buildRadar(snapshot);
const board: GateRow[] = RadarModel.boardRows(radar);
const issue = checkBoard(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ model: RadarModel.MODEL_VERSION, as_of: snapshot.as_of, rows: board })}\n`);

// The page recomputes the whole radar from the snapshot with the same 1-model.js, then checks every value
// it computed against the one board.json carries: BOARD_VALUES is that check's other side.
const boardValues = Object.fromEntries(board.map((r) => [r.slug, r.implied_value_usd]));
writeFileSync(
  join(out, 'data.js'),
  `// Written by main.ts: the sealed snapshot as read, and board.json's implied values for the page's parity check.\n` +
    `window.RADAR_SNAPSHOT = ${snapshotText.trim()};\nwindow.BOARD_VALUES = ${JSON.stringify(boardValues)};\n`,
);

/** Copy one directory's regular files into `to`, skipping dot-files. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const pages = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) fail(`screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view`);
for (const name of shots) if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: names are letters, digits and . _ -`);

// Written last: the scorer rebuilds the dossier from /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

const s = radar.summary;
process.stdout.write(
  `token radar ${RadarModel.MODEL_VERSION}: ${snapshot.protocols.length} protocols; ${board.length} ranked ` +
    `(${s.watchlist} watchlist, ${s.early} early); ${s.peers} live peers calibrate the multiples; ${s.set_aside} set aside\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${pages.length} files), screenshots/ (${shots.length}) and dossier.json to ${out}\n`,
);
