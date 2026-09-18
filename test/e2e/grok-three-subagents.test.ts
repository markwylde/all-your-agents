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
	THREE_GROK_AGENT_PROMPT,
	waitUntil,
} from './helpers.js';

test('grok -p: three general-purpose subagents start and end', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('grok three subagents', async () => {
		const { home, cwd } = await isolatedGrokHome();
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: stubProcesses,
			debounce: { quietMs: 15 },
		});
		const starts: string[] = [];
		const ends: string[] = [];
		aya.on('subagent:start', (s) => {
			if (s.type === 'general-purpose') starts.push(s.id);
		});
		aya.on('subagent:end', (s) => ends.push(`${s.id}:${s.status}`));
		await aya.start();
		const run = startPrintGrok(home, cwd, THREE_GROK_AGENT_PROMPT);
		try {
			await waitUntil(
				() => starts.length >= 3 && ends.length >= 3,
				240_000,
				() => `starts=${starts.join(',')} ends=${ends.join(',')}`,
			);
			assert.equal(new Set(starts).size, 3);
			assert.equal(ends.length, 3);
			assert.ok(
				ends.every((e) => e.endsWith(':completed')),
				ends.join(','),
			);
		} finally {
			run.child.kill();
			await run.done;
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});
