import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents, ohMyPi } from '../../src/index.js';
import { measureCost } from './cost.js';
import { rmQuiet, waitUntil } from './helpers.js';
import {
	isolatedOmpHome,
	ompLiveEnabled,
	ompProject,
	requireOmp,
	startInteractiveOmp,
	stopInteractiveOmp,
} from './omp-helpers.js';

test('omp on a terminal: live create, running before the transcript, idle, close, then history', async (t) => {
	if (!ompLiveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	requireOmp();
	await measureCost('omp create/status/close', async () => {
		const { cwd, mine } = await ompProject();
		const { userHome, home } = await isolatedOmpHome();
		const aya = AllYourAgents({ providers: [ohMyPi({ home })], debounce: { quietMs: 15 } });
		const log: string[] = [];
		aya.on('session:create', (s) => mine(s) && log.push(`create:${s.id}`));
		aya.on('session:open', (s) => mine(s) && log.push(`open:${s.id}`));
		aya.on('session:status', (s) => mine(s) && log.push(`status:${s.status}`));
		aya.on('session:close', (s) => mine(s) && log.push('close'));
		await aya.start();
		const run = startInteractiveOmp(
			userHome,
			cwd,
			'This is an automated test. Do not think at length. Reply with the single word PONG, then stop.',
		);
		const said = () => log.join(' | ');
		try {
			await waitUntil(() => log.some((l) => l.startsWith('create:')), 20_000, said);
			await waitUntil(() => log.includes('status:running'), 20_000, said);
			await waitUntil(
				() => log.lastIndexOf('status:idle') > log.indexOf('status:running'),
				25_000,
				said,
			);
			const session = aya.running().find(mine);
			assert.equal(session?.kind, 'interactive');
			assert.equal(session?.activity.lastTurn, 'completed');
			assert.ok(session?.model, 'the session reports its model');
			stopInteractiveOmp(run);
			await waitUntil(() => log.includes('close'), 8_000, said);
			const startOfToday = new Date();
			startOfToday.setHours(0, 0, 0, 0);
			const listed = await aya.sessions({ since: startOfToday.getTime() });
			assert.ok(listed.some((s) => s.harness === 'OhMyPi' && mine(s)));
		} finally {
			stopInteractiveOmp(run);
			await aya.stop();
			await rmQuiet(cwd);
			await rmQuiet(userHome);
		}
	});
});
