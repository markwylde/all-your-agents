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
	THREE_CODEX_AGENT_PROMPT,
	waitUntil,
} from './helpers.js';

test('codex exec: three collab subagents start and end', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	requireCodex();
	await measureCost('codex three subagents', async () => {
		const { home, cwd } = await isolatedCodexHome();
		const aya = AllYourAgents({
			providers: [codexCli({ home })],
			debounce: { quietMs: 15 },
		});
		const starts: string[] = [];
		const ends: string[] = [];
		aya.on('subagent:start', (s) => starts.push(s.id));
		aya.on('subagent:end', (s) => ends.push(`${s.id}:${s.status}`));
		await aya.start();
		const run = startExecCodex(home, cwd, THREE_CODEX_AGENT_PROMPT);
		try {
			await waitUntil(
				() => starts.length >= 3 && ends.length >= 3,
				240_000,
				() => `starts=${starts.length} ends=${ends.length}`,
			);
			const result = await run.done;
			assert.equal(result.code, 0, result.output);
		} finally {
			run.child.kill();
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});
