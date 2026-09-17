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
	trustProject,
	waitUntil,
} from './helpers.js';

const pickerScript = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../test/e2e/resume-picker.py',
);

test('claude --resume picker: arrows + enter reopen a session', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('resume picker', async () => {
		const { home } = await isolatedClaudeHome();
		// Use this repo as cwd so we skip the first-run "trust this folder" dialog;
		// session files still live in the isolated CLAUDE_CONFIG_DIR.
		const cwd = process.cwd();
		trustProject(cwd);
		const seed = startBackgroundClaude(home, cwd, 'Reply with only the word SEED then stop.');
		const short = await seed.id;
		await new Promise((resolve) => setTimeout(resolve, 2500));
		stopBackgroundClaude(home, short);
		seed.child.kill();

		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: stubProcesses,
			debounce: { quietMs: 15 },
		});
		const log: string[] = [];
		aya.on('session:create', (s) => log.push(`create:${s.id}`));
		aya.on('session:open', (s) => log.push(`open:${s.id}`));
		aya.on('session:status', (s) => log.push(`status:${s.status}`));
		await aya.start();

		const env = { ...claudeEnv(home), TERM: 'xterm-256color' };
		const py = spawn('python3', [pickerScript, 'Reply with only the word PICKED then stop.'], {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		py.stdout?.on('data', (c: Buffer) => {
			out += c.toString();
		});
		py.stderr?.on('data', (c: Buffer) => {
			out += c.toString();
		});
		py.on('error', (err) => {
			out += `SPAWN_ERROR ${err}`;
		});
		py.on('exit', (code) => {
			out += ` EXIT:${code}`;
		});
		try {
			await waitUntil(
				() => out.includes('PICKED'),
				25_000,
				() => `picker did not select a session: [${out}] ${log.join(' | ')} script=${pickerScript}`,
			);
			await waitUntil(
				() => log.some((l) => l.startsWith('create:') || l.startsWith('open:')),
				30_000,
				() => `no live session after picker: ${log.join(' | ')} / ${out.slice(-200)}`,
			);
			assert.ok(
				log.some((l) => l.startsWith('open:') || l.startsWith('create:')),
				log.join(' | '),
			);
		} finally {
			py.kill('SIGKILL');
			await aya.stop();
			await rmQuiet(home);
		}
	});
});
