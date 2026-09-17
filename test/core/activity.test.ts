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

function liveHarness() {
	let emitTurn: (fact: TurnFact) => void = () => {};
	const aya = AllYourAgents({
		providers: [
			{
				id: 'mem',
				harness: 'Memory',
				watch(ctx) {
					ctx.emit('session:create', { id: 's', harness: 'Memory', provider: 'mem', pid: 1 });
					emitTurn = (fact) => ctx.emit('turn', { sessionId: 's', ...fact });
					return () => {};
				},
			},
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	const seen: SessionActivity[] = [];
	aya.on('session:activity', (s) => seen.push(s.activity));
	return { aya, seen, turn: (fact: TurnFact) => emitTurn(fact) };
}

test('one turn ended several times fires one activity, first end wins', async () => {
	const { aya, seen, turn } = liveHarness();
	await aya.start();
	turn({ type: 'turn-started', at: 1 });
	turn({ type: 'tool-started', id: 't', name: 'Bash', startedAt: 2 });
	turn({ type: 'tool-finished', id: 't', at: 3 });
	const before = seen.length;
	// A reply split into thinking + text records, then turn_duration, then going idle.
	turn({ type: 'turn-ended', outcome: 'completed', endedAt: 10 });
	turn({ type: 'turn-ended', outcome: 'completed', endedAt: 11 });
	turn({ type: 'turn-ended', outcome: 'completed', endedAt: 12 });
	turn({ type: 'turn-ended', outcome: 'completed', endedAt: 13 });
	assert.equal(seen.length - before, 1);
	assert.equal(seen.at(-1)?.lastTurn, 'completed');
	assert.equal(aya.running()[0]?.activity.lastTurnEndedAt, 10);
	await aya.stop();
});

test('a failed end is not overwritten by a later completed end', async () => {
	const { aya, seen, turn } = liveHarness();
	await aya.start();
	turn({ type: 'turn-started', at: 1 });
	turn({ type: 'turn-ended', outcome: 'failed', error: 'api', endedAt: 5 });
	turn({ type: 'turn-ended', outcome: 'completed', endedAt: 6 });
	const activity = aya.running()[0]?.activity;
	assert.equal(activity?.lastTurn, 'failed');
	assert.equal(activity?.error, 'api');
	assert.equal(seen.filter((a) => a.lastTurn).length, 1);
	await aya.stop();
});

test('a new turn or tool call can end again', async () => {
	const { aya, seen, turn } = liveHarness();
	await aya.start();
	turn({ type: 'turn-started', at: 1 });
	turn({ type: 'turn-ended', outcome: 'completed', endedAt: 5 });
	// A task notification runs a tool and ends again without a user turn.
	turn({ type: 'tool-started', id: 't', name: 'Read', startedAt: 6 });
	turn({ type: 'tool-finished', id: 't', at: 7 });
	const before = seen.length;
	turn({ type: 'turn-ended', outcome: 'completed', endedAt: 8 });
	assert.equal(seen.length - before, 1);
	assert.equal(aya.running()[0]?.activity.lastTurnEndedAt, 8);
	turn({ type: 'turn-started', at: 9 });
	turn({ type: 'turn-ended', outcome: 'interrupted', endedAt: 10 });
	assert.equal(aya.running()[0]?.activity.lastTurn, 'interrupted');
	assert.equal(aya.running()[0]?.activity.lastTurnEndedAt, 10);
	await aya.stop();
});

test('replay drops repeated ends the same way', async () => {
	const aya = AllYourAgents({
		providers: [
			{
				id: 'mem',
				harness: 'Memory',
				watch(ctx) {
					ctx.emit('session:create', { id: 's', harness: 'Memory', provider: 'mem', pid: 1 });
					ctx.emit('activity:replay', {
						id: 's',
						facts: [
							{ type: 'turn-started' },
							{ type: 'turn-ended', outcome: 'failed', error: 'api', endedAt: 3 },
							{ type: 'turn-ended', outcome: 'completed', endedAt: 4 },
						],
					});
					return () => {};
				},
			},
		],
		processes: { info: async () => ({ alive: true }), watch: () => 'unsupported' },
	});
	await aya.start();
	const activity = aya.running()[0]?.activity;
	assert.equal(activity?.lastTurn, 'failed');
	assert.equal(activity?.lastTurnEndedAt, 3);
	await aya.stop();
});
