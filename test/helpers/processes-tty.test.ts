import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installTimerGuard } from '../../src/helpers/no-timers.js';
import { createLocalProcesses } from '../../src/helpers/processes.js';

test('tty names the terminal of a child on a pty, and nothing for a piped or dead one', async (t) => {
	try {
		execFileSync('sh', ['-c', 'command -v script && command -v pgrep'], { stdio: 'ignore' });
	} catch {
		return t.skip('needs script and pgrep');
	}
	const args =
		platform() === 'darwin' ? ['-q', '/dev/null', 'sleep', '30'] : ['-qc', 'sleep 30', '/dev/null'];
	// `script` refuses a socket for stdin, so it gets none.
	const onPty = spawn('script', args, { stdio: 'ignore' });
	const piped = spawn('sleep', ['30'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
	const procs = createLocalProcesses({ koffi: false });
	try {
		const tty = procs.tty;
		assert.ok(tty && onPty.pid && piped.pid);
		let child = 0;
		const started = Date.now();
		while (Date.now() - started < 3000 && !child) {
			try {
				const out = execFileSync('pgrep', ['-P', String(onPty.pid)], { encoding: 'utf8' });
				child = Number(out.trim().split('\n')[0]);
			} catch {
				await new Promise((r) => setTimeout(r, 50));
			}
		}
		assert.ok(child > 0, 'script forked its child');
		const guard = installTimerGuard();
		try {
			assert.match((await tty(child)) ?? '', /^(ttys\d+|pts\/\d+)$/);
			assert.equal(await tty(piped.pid), undefined);
			assert.equal(await tty(99_999_999), undefined);
			guard.assertIdle();
		} finally {
			guard.restore();
		}
	} finally {
		onPty.kill();
		piped.kill();
		await procs.close();
	}
});

test('claude, grok and codex providers do not call tty', () => {
	const src = join(dirname(fileURLToPath(import.meta.url)), '../../../src/providers');
	for (const name of ['claude-code', 'grok-build', 'codex-cli']) {
		for (const file of readdirSync(join(src, name))) {
			const text = readFileSync(join(src, name, file), 'utf8');
			assert.equal(/\.tty\b/.test(text), false, `${name}/${file}`);
		}
	}
});
