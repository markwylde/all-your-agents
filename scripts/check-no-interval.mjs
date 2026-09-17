import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../src', import.meta.url).pathname;
const allowed = 'helpers/coalesce.ts';
let failed = false;

function walk(dir) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			walk(full);
			continue;
		}
		if (!full.endsWith('.ts')) continue;
		const rel = relative(root, full);
		if (rel === allowed) continue;
		const text = readFileSync(full, 'utf8');
		if (/\bsetInterval\s*\(/.test(text)) {
			console.error(`setInterval is banned outside ${allowed}: src/${rel}`);
			failed = true;
		}
	}
}

walk(root);
if (failed) process.exit(1);
