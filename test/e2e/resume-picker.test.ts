import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AllYourAgents, claudeCode } from '../../src/index.js';
import { measureCost } from './cost.js';
import {
	claudeEnv,
	isolatedClaudeHome,
	liveEnabled,
	rmQuiet,
	startBackgroundClaude,
	stopBackgroundClaude,
	stubProcesses,
	waitUntil,
} from './helpers.js';

const pickerScript = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../test/e2e/resume-picker.py',
);

const SEED_PROMPT = 'Reply with only the word SEED.';

test('claude --resume picker: enter reopens a session', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('resume picker', async () => {
		const { home, cwd } = await isolatedClaudeHome();
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: stubProcesses,
			debounce: { quietMs: 15 },
		});
		const log: string[] = [];
		aya.on('session:create', (s) => log.push(`create:${s.id}`));
		aya.on('session:open', (s) => log.push(`open:${s.id}`));
		aya.on('session:close', (s) => log.push(`close:${s.id}`));
		await aya.start();
		// The picker lists interactive sessions only, so seed with `--bg` rather than `-p`.
		const seed = startBackgroundClaude(home, cwd, SEED_PROMPT);
		let picker: ReturnType<typeof spawn> | undefined;
		try {
			const short = await seed.id;
			const seeded = () => aya.running().find((s) => s.id.startsWith(short));
			await waitUntil(
				() => seeded()?.activity.lastTurn === 'completed',
				15_000,
				() => `seed turn did not complete: ${log.join(' | ')}`,
			);
			const id = seeded()?.id ?? '';
			stopBackgroundClaude(home, short);
			await waitUntil(
				() => log.includes(`close:${id}`),
				5_000,
				() => `seed did not close: ${log.join(' | ')}`,
			);

			picker = spawn('python3', [pickerScript, SEED_PROMPT], {
				cwd,
				env: { ...claudeEnv(home), TERM: 'xterm-256color' },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let out = '';
			const append = (chunk: Buffer) => {
				out += chunk.toString();
			};
			picker.stdout?.on('data', append);
			picker.stderr?.on('data', append);
			const exited = new Promise<void>((resolve) => picker?.on('exit', () => resolve()));
			await Promise.race([
				waitUntil(
					() => out.includes('PICKED'),
					20_000,
					() => `picker: ${out}`,
				),
				exited.then(() => assert.fail(`picker exited: ${out}`)),
			]);
			await waitUntil(
				() => aya.running().some((s) => s.id === id),
				10_000,
				() => `seed ${id} not live after picking: ${log.join(' | ')} / ${out}`,
			);
		} finally {
			seed.child.kill();
			if (picker && picker.exitCode === null) {
				const gone = new Promise((resolve) => picker?.on('exit', resolve));
				picker.kill('SIGTERM');
				await gone;
			}
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});
