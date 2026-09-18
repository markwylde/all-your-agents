import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents, grokBuild } from '../../src/index.js';
import { measureCost } from './cost.js';
import {
	isolatedGrokHome,
	liveEnabled,
	rmQuiet,
	startPrintGrok,
	stubProcesses,
	waitUntil,
} from './helpers.js';

test('grok -p: live create/open, status, close, then history', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('grok create/status/close', async () => {
		const { home, cwd } = await isolatedGrokHome();
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: stubProcesses,
			debounce: { quietMs: 15 },
		});
		const log: string[] = [];
		aya.on('session:create', (s) => log.push(`create:${s.id}`));
		aya.on('session:open', (s) => log.push(`open:${s.id}`));
		aya.on('session:status', (s) => log.push(`status:${s.status}`));
		aya.on('session:close', () => log.push('close'));
		await aya.start();
		const run = startPrintGrok(home, cwd, 'Reply with the single word PONG. Then stop.');
		try {
			await waitUntil(
				() => log.some((l) => l.startsWith('create:') || l.startsWith('open:')),
				60_000,
				() => log.join(' | '),
			);
			await waitUntil(
				() => log.some((l) => l.startsWith('status:')),
				60_000,
				() => log.join(' | '),
			);
			const result = await run.done;
			assert.equal(result.code, 0, result.output);
			await waitUntil(
				() => log.includes('close'),
				30_000,
				() => log.join(' | '),
			);
			const startOfToday = new Date();
			startOfToday.setHours(0, 0, 0, 0);
			const listed = await aya.sessions({ since: startOfToday.getTime() });
			assert.ok(listed.some((s) => s.harness === 'Grok' && s.kind === 'headless'));
		} finally {
			run.child.kill();
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});
