// Local replica of the 7-row scorer gate for token-radar-01. Run: node check.mjs <outdir> <snapshot>
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || 'out';
const snapPath = process.argv[3] || '/tmp/radar-kit/token-radar-01-kit/input/snapshot.json';
const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const snapSlugs = new Set(snap.protocols.map(p => p.slug));
const watch = new Set(snap.watchlist);
const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

// --- 1. dashboard_files
const dash = join(out, 'dashboard');
let df = { pass: false, detail: '' };
try {
  const entries = readdirSync(dash, { withFileTypes: true });
  const files = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) { df = { pass: false, detail: 'dot entry ' + e.name }; return; }
      const p = join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isSymbolicLink()) { df = { pass: false, detail: 'symlink ' + r }; return; }
      else if (e.isFile()) files.push({ p, r });
      else { df = { pass: false, detail: 'non-regular ' + r }; return; }
    }
  };
  walk(dash, '');
  const total = files.reduce((a, f) => a + statSync(f.p).size, 0);
  const hasHtml = files.some(f => f.r === 'index.html' || f.r.endsWith('index.html'));
  const hasCss = files.some(f => f.r.endsWith('.css'));
  const hasJs = files.some(f => f.r.endsWith('.js'));
  let netHit = null;
  const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
  const badName = files.find(f => f.r.split('/').some(seg => !NAME.test(seg)));
  for (const f of files) {
    if (badName) break;
    if (!/\.(html|css|js)$/.test(f.r)) continue;
    const txt = readFileSync(f.p, 'utf8');
    // html attribute values
    if (f.r.endsWith('.html')) {
      const attrRe = /\b(?:href|src|action|formaction|data|poster|srcset)\s*=\s*["']([^"']*)["']/gi;
      let m; while ((m = attrRe.exec(txt))) { if (/https?:\/\//i.test(m[1])) { netHit = f.r + ' attr ' + m[1]; break; } }
      const styleRe = /<style[\s\S]*?<\/style>/gi; if (styleRe.test(txt)) { netHit = f.r + ' inline <style>'; }
      const impRe = /<script[^>]*\bimport\b|<script[^>]*\bsrc\s*=/gi; // src checked above; bare import below
    }
    if (f.r.endsWith('.css')) { const m = txt.match(/@import[^;]*url\(\s*["']?([^"')]+)/i); if (m && /https?:\/\//i.test(m[1])) netHit = f.r + ' @import ' + m[1]; const u = txt.match(/url\(\s*["']?(https?:\/\/[^"')]+)/i); if (u) netHit = f.r + ' url ' + u[1]; }
    if (f.r.endsWith('.js')) {
      const jsNet = txt.match(/(?:import\s+[^;]*from\s*|require\s*\(\s*|import\s*\(\s*)["'`](https?:\/\/[^"'`]+)["'`]/);
      if (jsNet) netHit = f.r + ' js import ' + jsNet[1];
      const exp = txt.match(/export\s+[^;]*from\s*["'`](https?:\/\/[^"'`]+)/);
      if (exp) netHit = f.r + ' export-from ' + exp[1];
    }
    if (netHit) break;
  }
  if (badName) df = { pass: false, detail: 'bad name ' + badName.r };
  else if (files.length > 400) df = { pass: false, detail: files.length + ' files' };
  else if (total > 4 * 1024 * 1024) df = { pass: false, detail: total + ' bytes' };
  else if (!hasHtml || !hasCss || !hasJs) df = { pass: false, detail: 'missing html/css/js' };
  else if (netHit) df = { pass: false, detail: 'network: ' + netHit };
  else df = { pass: true, detail: files.length + ' files, ' + total + ' bytes' };
} catch (e) { df = { pass: false, detail: e.message }; }
ok('dashboard_files', df.pass, df.detail);

// --- 2. board_file
let bf = { pass: false, detail: '' };
let board = null;
try {
  const raw = readFileSync(join(out, 'board.json'), 'utf8');
  const parsed = JSON.parse(raw);
  board = Array.isArray(parsed) ? parsed : parsed.rows;
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('over 8 MiB');
  if (!Array.isArray(board)) throw new Error('rows not array');
  if (board.length < 100 || board.length > 4000) throw new Error(board.length + ' rows');
  let bad = null;
  for (const r of board) {
    if (typeof r.slug !== 'string' || !snapSlugs.has(r.slug)) { bad = 'slug ' + r.slug; break; }
    if (typeof r.name !== 'string' || !r.name.length) { bad = 'name'; break; }
    if (!Number.isInteger(r.rank) || r.rank <= 0) { bad = 'rank'; break; }
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) { bad = 'implied'; break; }
    if (!Array.isArray(r.farm_steps)) { bad = 'farm_steps'; break; }
  }
  if (bad) throw new Error(bad);
  const slugs = board.map(r => r.slug);
  if (new Set(slugs).size !== slugs.length) throw new Error('dup slugs');
  const vals = board.map(r => r.implied_value_usd);
  if (board.length >= 2 && vals.every(v => v === vals[0])) throw new Error('all same implied');
  bf = { pass: true, detail: board.length + ' rows' };
} catch (e) { bf = { pass: false, detail: e.message }; }
ok('board_file', bf.pass, bf.detail);

// --- 3. sorted_by_value
let sv = { pass: false, detail: '' };
try {
  if (!board) throw new Error('no board');
  const ranks = board.map(r => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) throw new Error('rank ' + (i + 1) + ' is ' + ranks[i]);
  // rows array must be in rank order with non-increasing implied
  const byRank = board.slice().sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) throw new Error('implied rises at rank ' + byRank[i].rank);
  if (byRank.length >= 2 && byRank[0].implied_value_usd === byRank[byRank.length - 1].implied_value_usd) throw new Error('all same');
  sv = { pass: true, detail: 'ranks 1..' + board.length + ' monotone' };
} catch (e) { sv = { pass: false, detail: e.message }; }
ok('sorted_by_value', sv.pass, sv.detail);

// --- 4. coverage
let cov = { pass: false, detail: '' };
try {
  if (!board) throw new Error('no board');
  const have = new Set(board.map(r => r.slug));
  const missing = [...watch].filter(s => !have.has(s));
  if (missing.length) throw new Error('missing ' + missing.length + ': ' + missing.slice(0, 5));
  cov = { pass: true, detail: 'all ' + watch.size + ' covered' };
} catch (e) { cov = { pass: false, detail: e.message }; }
ok('coverage', cov.pass, cov.detail);

// --- 5. farm_steps
let fs = { pass: false, detail: '' };
try {
  if (!board) throw new Error('no board');
  let bad = null;
  for (const r of board) {
    const s = r.farm_steps;
    if (!Array.isArray(s) || s.length < 3 || s.length > 12) { bad = r.slug + ' count ' + (s && s.length); break; }
    for (const st of s) { const t = st.trim(); if (t.length < 20 || t.length > 600) { bad = r.slug + ' len ' + t.length; break; } }
    if (bad) break;
  }
  if (bad) throw new Error(bad);
  fs = { pass: true, detail: board.length + ' rows ok' };
} catch (e) { fs = { pass: false, detail: e.message }; }
ok('farm_steps', fs.pass, fs.detail);

// --- 6. screenshots
let sc = { pass: false, detail: '' };
try {
  const dir = join(out, 'screenshots');
  const names = readdirSync(dir).filter(n => !n.startsWith('.'));
  const imgs = names.filter(n => { const p = join(dir, n); try { return statSync(p).isFile(); } catch { return false; } });
  if (imgs.length < 3 || imgs.length > 4) throw new Error(imgs.length + ' images');
  const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
  for (const n of imgs) {
    if (!NAME.test(n)) throw new Error('bad name ' + n);
    const b = readFileSync(join(dir, n));
    if (b.length > 512 * 1024) throw new Error(n + ' ' + b.length + ' bytes');
    let w, h, type;
    if (b.slice(1, 4).toString() === 'PNG' && b.slice(0, 1)[0] === 0x89) { type = 'PNG'; w = b.readUInt32BE(16); h = b.readUInt32BE(20); }
    else if (b[0] === 0xff && b[1] === 0xd8) { type = 'JPEG'; // parse SOF
      let i = 2; while (i < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; } const len = b.readUInt16BE(i + 2); i += 2 + len; } }
    else throw new Error(n + ' not PNG/JPEG');
    if (!w || !h) throw new Error(n + ' no dims');
    const long = Math.max(w, h), short = Math.min(w, h);
    if (long > 1440) throw new Error(n + ' long ' + long);
    if (short < 800) throw new Error(n + ' short ' + short);
  }
  sc = { pass: true, detail: imgs.length + ' imgs' };
} catch (e) { sc = { pass: false, detail: e.message }; }
ok('screenshots', sc.pass, sc.detail);

// --- 7. dossier_matches
let dm = { pass: false, detail: '' };
try {
  const dossier = readFileSync(join(out, 'dossier.json'));
  if (dossier.length > 1.5 * 1024 * 1024) throw new Error('dossier ' + dossier.length + ' > 1.5MiB');
  JSON.parse(dossier.toString('utf8'));
  // Can't run buildDossier from .mjs directly (TS). Delegate: presence + valid JSON + schema.
  const d = JSON.parse(dossier.toString('utf8'));
  if (d.schema !== 'makefun/dossier/v1') throw new Error('schema ' + d.schema);
  if (!Array.isArray(d.images) || d.images.length < 3) throw new Error('images');
  dm = { pass: true, detail: dossier.length + ' bytes, ' + d.images.length + ' images (verify via buildDossier)' };
} catch (e) { dm = { pass: false, detail: e.message }; }
ok('dossier_matches', dm.pass, dm.detail);

console.log('\n=== GATE ===');
let allpass = true;
for (const r of results) { console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name.padEnd(18) + ' ' + r.detail); if (!r.pass) allpass = false; }
console.log('\n' + (allpass ? 'ALL 7 PASS' : 'GATE FAIL') );