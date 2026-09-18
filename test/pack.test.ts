import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('npm pack installs and imports both entry points', async (t) => {
	if (process.env.AYA_SKIP_PACK === '1') {
		t.skip('skipped');
		return;
	}
	const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
	const dir = mkdtempSync(join(tmpdir(), 'aya-pack-'));
	try {
		execFileSync('npm', ['pack', '--pack-destination', dir], { cwd: root, stdio: 'pipe' });
		const tgz = execFileSync('sh', ['-c', 'ls *.tgz'], { cwd: dir, encoding: 'utf8' }).trim();
		execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'pipe' });
		execFileSync('npm', ['install', join(dir, tgz)], { cwd: dir, stdio: 'pipe' });
		const src = `import aya, { builtInProviders, grokBuild, codexCli } from '@markwylde/all-your-agents';
import { createGrokFixtureDriver, createCodexFixtureDriver, defineConformanceTests } from '@markwylde/all-your-agents/testing';
if (builtInProviders.length !== 3) throw new Error('providers');
if (!builtInProviders.some((p) => p.id === 'grok-build')) throw new Error('grok');
if (!builtInProviders.some((p) => p.id === 'codex-cli')) throw new Error('codex');
if (typeof grokBuild !== 'function' || typeof createGrokFixtureDriver !== 'function') throw new Error('grok exports');
if (typeof codexCli !== 'function' || typeof createCodexFixtureDriver !== 'function') throw new Error('codex exports');
if (typeof aya !== 'function') throw new Error('default');
if (typeof defineConformanceTests !== 'function') throw new Error('testing');
`;
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(dir, 'check.mjs'), src);
		execFileSync('node', [join(dir, 'check.mjs')], { cwd: dir, stdio: 'pipe' });
		const bin = join(dir, 'node_modules', '.bin', 'all-your-agents');
		assert.equal(existsSync(join(dir, 'node_modules', '.bin', 'aya')), false);
		const version = execFileSync(bin, ['--version'], { cwd: dir, encoding: 'utf8' });
		assert.match(version, /^\d+\.\d+\.\d+/);
		const json = execFileSync(bin, ['--json'], {
			cwd: dir,
			encoding: 'utf8',
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: join(dir, 'claude-home'),
				GROK_HOME: join(dir, 'grok-home'),
				CODEX_HOME: join(dir, 'codex-home'),
			},
		});
		assert.deepEqual(JSON.parse(json), []);
		assert.ok(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
