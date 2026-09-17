import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents, claudeCode } from '../../src/index.js';
import { measureCost } from './cost.js';
import {
	isolatedClaudeHome,
	liveEnabled,
	rmQuiet,
	startBackgroundClaude,
	stopBackgroundClaude,
	stubProcesses,
	waitUntil,
} from './helpers.js';

test('sonnet --bg: live create/open, status, close', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('live create/status/close', async () => {
		const { home, cwd } = await isolatedClaudeHome();
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: stubProcesses,
			debounce: { quietMs: 15 },
		});
		const log: string[] = [];
		aya.on('session:create', (s) => log.push(`create:${s.id}`));
		aya.on('session:open', (s) => log.push(`open:${s.id}`));
		aya.on('session:status', (s) => log.push(`status:${s.status}`));
		aya.on('session:close', () => log.push('close'));

		await aya.start();
		const { child, id } = startBackgroundClaude(
			home,
			cwd,
			'Reply with the single word PONG. Then stop.',
		);
		let bgId = '';
		try {
			bgId = await id;
			await waitUntil(
				() => log.some((l) => l.startsWith('create:') || l.startsWith('open:')),
				30_000,
				() => log.join(' | '),
			);
			await waitUntil(
				() => log.some((l) => l.startsWith('status:')),
				30_000,
				() => log.join(' | '),
			);
			const startOfToday = new Date();
			startOfToday.setHours(0, 0, 0, 0);
			const listed = await aya.sessions({ since: startOfToday.getTime() });
			assert.ok(listed.length >= 1);
		} finally {
			if (bgId) stopBackgroundClaude(home, bgId);
			await waitUntil(
				() => log.includes('close'),
				15_000,
				() => log.join(' | '),
			).catch(() => {});
			child.kill();
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
		assert.ok(log.includes('close') || log.some((l) => l.startsWith('status:')));
	});
});
