import { readFileSync } from 'node:fs';
import { buildDossier } from './vendor/makefun-board.ts';
const out = process.argv[2] || 'out';
const got = readFileSync(out + '/dossier.json', 'utf8');
const want = buildDossier(out, { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } });
console.log('match:', got === want, '| got', Buffer.byteLength(got), 'want', Buffer.byteLength(want));
if (got !== want) process.exit(1);