import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSummary } from '../../../src/providers/antigravity-cli/data.js';
import { fields } from '../../../src/providers/antigravity-cli/protobuf.js';
import { decodeStep, facts } from '../../../src/providers/antigravity-cli/steps.js';
import { assistant, proto, row, summary, user } from './fixtures.js';

test('summary validates roots, local file URLs, UTC timestamps and known states', () => {
	const parsed = parseSummary(summary());
	assert.equal(parsed?.snapshot.cwd, '/tmp/aya project');
	assert.equal(parsed?.snapshot.updatedAt, Date.parse('2027-01-15T08:00:00Z'));
	assert.equal(parsed?.status, 'idle');
	assert.equal(parseSummary({ ...summary(), conversation_id: '../outside' }), undefined);
	assert.equal(parseSummary({ ...summary(), parent_conversation_id: 'parent' }), undefined);
	for (const status of ['RUNNING', 'BUSY', 'CANCELING'])
		assert.equal(
			parseSummary({ ...summary(), status: `CASCADE_RUN_STATUS_${status}` })?.status,
			'running',
		);
	const unknown = parseSummary({
		...summary(),
		workspace_uris: '["https://remote/project"]',
		status: 'future',
		last_modified_time: '2027-01-15 08:00:00',
	});
	assert.equal(unknown?.status, undefined);
	assert.equal(unknown?.snapshot.cwd, undefined);
	assert.equal(unknown?.snapshot.updatedAt, undefined);
});

test('verified text and terminal reason mappings preserve raw and times', () => {
	const raw = user();
	const event = decodeStep(raw)?.events[0];
	assert.equal(event?.kind, 'user');
	assert.equal(event?.raw, raw);
	assert.equal(event?.at, 1800000000000);
	for (const [reason, outcome] of [
		[2, 'completed'],
		[3, 'completed'],
		[13, 'failed'],
		[16, 'interrupted'],
		[17, 'failed'],
		[18, 'failed'],
		[19, 'failed'],
		[20, 'failed'],
	] as const) {
		const events = decodeStep(assistant(1, reason))?.events;
		assert.equal(events?.at(-1)?.kind, 'turn-end');
		assert.deepEqual(facts(events ?? []).at(-1), {
			type: 'turn-ended',
			outcome,
			endedAt: 1800000002000,
		});
	}
	for (const reason of [0, 1, 10, 999])
		assert.equal(decodeStep(assistant(1, reason))?.events.length, 1);
	assert.equal(decodeStep(assistant(1, 2, 2))?.events.length, 0);
});

test('tool calls, results, model names and cancellation use explicit fields', () => {
	const call = proto([1, 'call-1'], [2, 'read_file']);
	const planner = row(0, 15, 20, proto([7, call], [12, 10]));
	assert.equal(decodeStep(planner)?.events[0]?.kind, 'tool');
	const tool = row(1, 132, 141, proto(), 7, proto([4, call], [24, proto([8, 'model-name'])]));
	assert.equal(decodeStep(tool)?.model, 'model-name');
	assert.deepEqual(
		decodeStep(tool)?.events.map((e) => e.kind),
		['tool', 'tool-result'],
	);
	assert.equal(
		decodeStep(row(2, 132, 140, proto(), 6))?.events.some((e) => e.kind === 'turn-end'),
		false,
	);
});

test('malformed, oversized, mismatched and unsupported payloads fail closed', () => {
	for (const bytes of [
		new Uint8Array([10, 20, 1]),
		new Uint8Array([128]),
		new Uint8Array([0]),
		new Uint8Array(4 * 1024 * 1024 + 1),
	]) {
		assert.equal(decodeStep({ ...user(), step_payload: bytes }), undefined);
	}
	assert.equal(decodeStep({ ...user(), step_format: 1 }), undefined);
	assert.equal(decodeStep({ ...user(), status: 7 }), undefined);
	assert.throws(() => fields(new Uint8Array(Array(12).fill(255))));
	assert.equal(decodeStep(row(2, 999, 200, proto()))?.events.length, 0);
});

test('cancelled or failed response rows override stale stop reasons; cleared rows emit nothing', () => {
	for (const status of [6, 12, 7]) {
		const event = decodeStep(assistant(1, 2, status))?.events.at(-1);
		assert.ok(event?.kind === 'turn-end');
		assert.equal(event.outcome, status === 7 ? 'failed' : 'interrupted');
	}
	for (const status of [4, 5]) assert.deepEqual(decodeStep(assistant(1, 2, status))?.events, []);
});
