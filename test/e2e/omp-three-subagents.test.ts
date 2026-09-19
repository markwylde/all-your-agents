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
	THREE_OMP_AGENT_PROMPT,
} from './omp-helpers.js';

test('omp: three task subagents start and complete', async (t) => {
	if (!ompLiveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	requireOmp();
	await measureCost('omp three subagents', async () => {
		const { cwd, mine } = await ompProject();
		const { userHome, home } = await isolatedOmpHome();
		const aya = AllYourAgents({ providers: [ohMyPi({ home })], debounce: { quietMs: 15 } });
		const log: string[] = [];
		const ids = new Set<string>();
		aya.on('session:create', (s) => {
			if (mine(s)) ids.add(s.id);
		});
		aya.on('subagent:start', (sub) => ids.has(sub.sessionId) && log.push(`start:${sub.id}`));
		aya.on(
			'subagent:end',
			(sub) => ids.has(sub.sessionId) && log.push(`end:${sub.id}:${sub.status}`),
		);
		await aya.start();
		const run = startInteractiveOmp(userHome, cwd, THREE_OMP_AGENT_PROMPT);
		const said = () => log.join(' | ');
		try {
			await waitUntil(() => log.filter((l) => l.startsWith('start:')).length >= 3, 28_000, said);
			await waitUntil(() => log.filter((l) => l.startsWith('end:')).length >= 3, 28_000, said);
			assert.equal(log.filter((l) => l.endsWith(':completed')).length, 3, said());
		} finally {
			stopInteractiveOmp(run);
			await aya.stop();
			await rmQuiet(cwd);
			await rmQuiet(userHome);
		}
	});
});
