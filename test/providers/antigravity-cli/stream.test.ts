import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fs, SqliteRow } from '../../../src/helpers/types.js';
import { decodeStep, facts } from '../../../src/providers/antigravity-cli/steps.js';
import { readStream, streamState } from '../../../src/providers/antigravity-cli/stream.js';
import { assistant, proto, row, user } from './fixtures.js';

function reader(rows: SqliteRow[], gen: SqliteRow[] = [], exec: SqliteRow[] = []) {
	return {
		fs: { stat: async () => ({ isFile: true }) } as unknown as Fs,
		sqlite: {
			query: async (_path: string, sql: string, params: unknown[] = []) =>
				sql.includes('FROM gen_metadata')
					? gen
					: sql.includes('FROM executor_metadata')
						? exec
						: rows.filter((r) => Number(r.idx) > Number(params[0] ?? -1)),
		},
	};
}

test('real agy stop-pattern with tool calls keeps a turn open', () => {
	const planner = row(1, 15, 20, proto([7, proto([1, 'call'], [2, 'run_command'])], [12, 2]));
	assert.deepEqual(
		decodeStep(planner)?.events.map((e) => e.kind),
		['tool'],
	);
});

test('generation step indices preserve model changes within an execution', async () => {
	const gen = [
		{
			idx: 0,
			data: proto([1, proto([21, 'Model One'])], [2, new Uint8Array([1])], [4, 'execution']),
		},
		{
			idx: 1,
			data: proto([1, proto([21, 'Model Two'])], [2, new Uint8Array([3])], [4, 'execution']),
		},
	];
	const result = await readStream(
		reader([user(), assistant(), user(2), assistant(3)], gen),
		'/fixture.db',
		streamState(),
	);
	assert.equal(result.model, 'Model Two');
	assert.deepEqual(
		result.events.filter((e) => e.kind === 'assistant').map((e) => e.model),
		['Model One', 'Model Two'],
	);
	assert.deepEqual(
		(
			await readStream(
				reader([user(), assistant(), user(2), assistant(3)], gen),
				'/fixture.db',
				result.state,
			)
		).events,
		[],
	);
});

test('background completion appears once after later records without replaying text', async () => {
	const call = proto([1, 'task'], [2, 'run_command']);
	const pending = row(1, 132, 140, proto(), 2, proto([4, call]));
	const rows = [user(), pending, assistant(2)];
	const ctx = reader(rows);
	const first = await readStream(ctx, '/fixture.db', streamState());
	assert.deepEqual(
		first.events.map((e) => e.kind),
		['user', 'tool', 'assistant', 'turn-end'],
	);
	rows[1] = row(1, 132, 140, proto(), 3, proto([4, call]));
	const second = await readStream(ctx, '/fixture.db', first.state);
	assert.deepEqual(
		second.events.map((e) => e.kind),
		['tool-result'],
	);
	assert.deepEqual((await readStream(ctx, '/fixture.db', second.state)).events, []);
});

test('executor failure arrives after the consumed final step and is emitted once', async () => {
	const endings: SqliteRow[] = [];
	const ctx = reader([user()], [], endings);
	const first = await readStream(ctx, '/fixture.db', streamState());
	endings.push({ idx: 0, data: proto([1, 1], [3, 0], [12, 'Fixture model failure']) });
	const second = await readStream(ctx, '/fixture.db', first.state);
	assert.equal(second.events[0]?.kind, 'error');
	assert.equal(facts(second.events).at(-1)?.type, 'turn-ended');
	assert.ok(
		facts(second.events).some(
			(f) => f.type === 'turn-ended' && f.error === 'Fixture model failure',
		),
	);
	assert.ok(second.events[1]?.kind === 'turn-end' && second.events[1].outcome === 'failed');
	assert.deepEqual((await readStream(ctx, '/fixture.db', second.state)).events, []);
});

test('question, elicitation and permission interactions stay distinct', () => {
	for (const [key, reason] of [
		[22, 'ask'],
		[20, 'elicitation'],
		[21, 'approval'],
	] as const) {
		const pending = row(1, 132, 140, proto(), 9);
		pending.step_payload = new Uint8Array([
			...(pending.step_payload as Uint8Array),
			...proto([56, proto([key, proto()])]),
		]);
		assert.equal(decodeStep(pending)?.waitingFor, reason);
	}
});

test('malformed optional generation metadata does not suppress valid transcript', async () => {
	const result = await readStream(
		reader([user(), assistant()], [{ idx: 0, data: proto([1, new Uint8Array([10, 99])]) }]),
		'/fixture.db',
		streamState(),
	);
	assert.deepEqual(
		result.events.map((e) => e.kind),
		['user', 'assistant', 'turn-end'],
	);
});
