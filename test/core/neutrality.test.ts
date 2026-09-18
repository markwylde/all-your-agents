import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '../../../src');

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (full.endsWith('.ts')) out.push(full);
	}
	return out;
}

const HARNESS_HOMES = /\.claude|\.grok|GROK_HOME/;

test('core does not import providers or mention a harness home', () => {
	const files = walk(join(src, 'core'));
	assert.ok(files.length > 0);
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		const rel = relative(src, file);
		assert.equal(/providers\//.test(text), false, rel);
		assert.equal(HARNESS_HOMES.test(text), false, rel);
	}
});

test('providers do not import node:fs or node:child_process', () => {
	let files: string[] = [];
	try {
		files = walk(join(src, 'providers'));
	} catch {
		return;
	}
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		const rel = relative(src, file);
		assert.equal(/from ['"]node:fs['"]/.test(text), false, rel);
		assert.equal(/from ['"]node:child_process['"]/.test(text), false, rel);
	}
});

test('neutrality test fails when a violation is introduced', () => {
	const fakeCore = `import '../providers/claude-code/index.js';\nconst home = '.claude';\n`;
	assert.ok(/providers\//.test(fakeCore) && HARNESS_HOMES.test(fakeCore));
	assert.ok(HARNESS_HOMES.test(`const home = join(homedir(), '.grok');`));
	assert.ok(HARNESS_HOMES.test('process.env.GROK_HOME'));
	const fakeProvider = `import { readFile } from 'node:fs';\nimport { exec } from 'node:child_process';\n`;
	assert.ok(/from ['"]node:fs['"]/.test(fakeProvider));
	assert.ok(/from ['"]node:child_process['"]/.test(fakeProvider));
});
