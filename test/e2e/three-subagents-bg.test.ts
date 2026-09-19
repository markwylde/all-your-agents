import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents, claudeCode } from '../../src/index.js';
import type { Subagent } from '../../src/types.js';
import { measureCost } from './cost.js';
import {
	isolatedClaudeHome,
	liveEnabled,
	rmQuiet,
	startBackgroundClaude,
	stopBackgroundClaude,
	stubProcesses,
	THREE_AGENT_PROMPT,
	waitUntil,
} from './helpers.js';

test('claude --bg: 3 subagents start and end', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('3 subagents live', async () => {
		const { home, cwd } = await isolatedClaudeHome();
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: stubProcesses,
			debounce: { quietMs: 15 },
		});
		const starts: Subagent[] = [];
		const ends: Subagent[] = [];
		const log: string[] = [];
		aya.on('session:create', (s) => log.push(`create:${s.id}`));
		aya.on('session:open', (s) => log.push(`open:${s.id}`));
		aya.on('session:status', (s) => log.push(`status:${s.status}`));
		aya.on('subagent:start', (sub) => {
			starts.push(sub);
			log.push(`start:${sub.id}`);
		});
		aya.on('subagent:end', (sub) => {
			ends.push(sub);
			log.push(`end:${sub.id}:${sub.status}`);
		});
		aya.on('session:close', () => log.push('close'));

		await aya.start();
		const { child, id } = startBackgroundClaude(home, cwd, THREE_AGENT_PROMPT);
		let bgId = '';
		try {
			bgId = await id;
			log.push(`bg:${bgId}`);
			await waitUntil(
				() => starts.length >= 3,
				25_000,
				() => `3 starts; have ${starts.length}: ${log.join(' | ')}`,
			);
			await waitUntil(
				() => ends.length >= 3,
				25_000,
				() => `3 ends; have ${ends.length}: ${log.join(' | ')}`,
			);
			assert.equal(new Set(starts.map((s) => s.id)).size, 3);
			assert.ok(
				log.some((l) => l.startsWith('create:') || l.startsWith('open:')),
				`no session event: ${log.join(' | ')}`,
			);
			const kids = await aya.running()[0]?.subagents();
			assert.ok((kids?.length ?? 0) >= 3, `subagents()=${kids?.length}`);
		} finally {
			if (bgId) stopBackgroundClaude(home, bgId);
			child.kill();
			await aya.stop();
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});
