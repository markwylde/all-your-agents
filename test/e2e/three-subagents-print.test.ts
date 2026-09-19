import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllYourAgents, claudeCode } from '../../src/index.js';
import { measureCost } from './cost.js';
import {
	claudeEnv,
	claudeModelArgs,
	isolatedClaudeHome,
	liveEnabled,
	rmQuiet,
	stubProcesses,
	THREE_AGENT_PROMPT,
} from './helpers.js';

test('claude -p: 3 subagents show up in inspect history', async (t) => {
	if (!liveEnabled()) {
		t.skip('set AYA_LIVE=1 and OPENROUTER_API_KEY');
		return;
	}
	await measureCost('3 subagents print-mode', async () => {
		const { spawnSync } = await import('node:child_process');
		const { home, cwd } = await isolatedClaudeHome();
		try {
			const result = spawnSync(
				'claude',
				[
					'-p',
					'--output-format',
					'text',
					'--dangerously-skip-permissions',
					...claudeModelArgs(),
					'--max-turns',
					'8',
					THREE_AGENT_PROMPT,
				],
				{ cwd, env: claudeEnv(home), encoding: 'utf8', timeout: 25_000 },
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(result.stdout, /DONE|ALPHA|BETA|GAMMA/i);

			const aya = AllYourAgents({ providers: [claudeCode({ home })], processes: stubProcesses });
			const listed = await aya.sessions({ since: 0 });
			assert.ok(listed.length >= 1, 'no historical session');
			const session = listed[0];
			assert.ok(session);
			const events: string[] = [];
			for await (const turn of session.transcript()) {
				for (const event of turn.events) {
					if (event.kind === 'subagent') events.push(event.id);
				}
			}
			assert.equal(events.length, 3, `subagent events=${events.join(',')}`);
			const kids = await session.subagents();
			assert.ok(kids.length >= 3, `history subagents()=${kids.length}`);
			await aya.stop();
		} finally {
			await rmQuiet(home);
			await rmQuiet(cwd);
		}
	});
});
