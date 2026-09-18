import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents, codexCli } from '../../src/index.js';
import { measureCost } from './cost.js';
import {
	isolatedCodexHome,
	liveEnabled,
	requireCodex,
	rmQuiet,
	startExecCodex,
	waitUntil,
} from './helpers.js';

test('codex exec: live create/open, status, close, then history', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	requireCodex();
	await measureCost('codex create/status/close', async () => {
		const { home, cwd } = await isolatedCodexHome();
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			debounce: { quietMs: 15 },
		});
		const log: string[] = [];
		aya.on('session:create', (s) => log.push(`create:${s.id}`));
		aya.on('session:open', (s) => log.push(`open:${s.id}`));
		aya.on('session:status', (s) => log.push(`status:${s.status}`));
		aya.on('session:close', () => log.push('close'));
		await aya.start();
		const run = startExecCodex(
			home,
			cwd,
			'This is an automated test. Do not think at length. Reply with the single word PONG, then stop.',
		);
		try {
			await waitUntil(
				() => log.some((l) => l.startsWith('create:') || l.startsWith('open:')),
				20_000,
				() => log.join(' | '),
			);
			await waitUntil(
				() => log.some((l) => l.startsWith('status:')),
				20_000,
				() => log.join(' | '),
			);
			const result = await run.done;
			assert.equal(result.code, 0, result.output);
			await waitUntil(
				() => log.includes('close'),
				8_000,
				() => log.join(' | '),
			);
			const startOfToday = new Date();
			startOfToday.setHours(0, 0, 0, 0);
			const listed = await aya.sessions({ since: startOfToday.getTime() });
			assert.ok(listed.some((s) => s.harness === 'Codex' && s.kind === 'headless'));
		} finally {
			run.child.kill();
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});
