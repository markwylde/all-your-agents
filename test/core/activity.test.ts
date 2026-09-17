import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyActivity, reduceActivity } from '../../src/core/activity.js';
import { AllYourAgents } from '../../src/index.js';
import type { SessionActivity, TurnFact } from '../../src/types.js';

function fold(facts: TurnFact[]): SessionActivity {
	return facts.reduce(reduceActivity, emptyActivity());
}

test('done vs never-ran', () => {
	assert.equal(emptyActivity().lastTurn, undefined);
	const done = fold([
		{ type: 'turn-started' },
		{ type: 'turn-ended', outcome: 'completed', endedAt: 1 },
	]);
	assert.equal(done.lastTurn, 'completed');
	assert.equal(done.tool, undefined);
});

test('error stands through idle (idle is not a turn fact)', () => {
	const failed = fold([
		{ type: 'turn-started' },
		{ type: 'turn-ended', outcome: 'failed', error: 'api', endedAt: 2 },
	]);
	assert.equal(failed.lastTurn, 'failed');
	assert.equal(failed.error, 'api');
	const still = reduceActivity(failed, { type: 'tool-finished', id: 'nope' });
	assert.equal(still.error, 'api');
	const next = reduceActivity(failed, { type: 'turn-started' });
	assert.equal(next.error, undefined);
	assert.equal(next.lastTurn, undefined);
});

test('replay emits one activity', async () => {
	const aya = AllYourAgents({
		providers: [
			{
				id: 'mem',
				harness: 'Memory',
				watch(ctx) {
					ctx.emit('session:create', { id: 's', harness: 'Memory', provider: 'mem' });
					ctx.emit('activity:replay', {
						id: 's',
						facts: [
							{ type: 'turn-started' },
							{ type: 'tool-started', id: '1', name: 'Bash' },
							{ type: 'tool-finished', id: '1' },
							{ type: 'turn-ended', outcome: 'completed', endedAt: 3 },
						],
					});
					return () => {};
				},
			},
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	let n = 0;
	aya.on('session:activity', () => n++);
	await aya.start();
	assert.equal(n, 1);
	assert.equal(aya.running()[0]?.activity.lastTurn, 'completed');
	await aya.stop();
});
