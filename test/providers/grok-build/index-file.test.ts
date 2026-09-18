import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeUtf8 } from '../../../src/helpers/bytes.js';
import {
	acceptEntry,
	allowedIndexFields,
	INDEX_MAX_BYTES,
	parseIndex,
} from '../../../src/providers/grok-build/index-file.js';

const ID = '01a0b474-0a8c-7002-b1fd-ff90b332cdc3';
const bytes = (value: unknown) => encodeUtf8(JSON.stringify(value));
const START = Date.parse('2026-09-18T12:00:00Z');
const at = (offsetMs: number) => new Date(START + offsetMs).toISOString();

const one = (openedAt: string) =>
	parseIndex(bytes([{ session_id: ID, pid: 42, cwd: '/tmp/app', opened_at: openedAt }]))?.[0];

test('opened_at is compared with the process start, with no upper bound', () => {
	const alive = { alive: true, startTime: START };
	const e60 = one(at(60_000));
	assert.ok(e60 && acceptEntry(e60, alive), '60 s after start');
	const e4 = one(at(-4000));
	assert.ok(e4 && acceptEntry(e4, alive), '4 s before start');
	const e6 = one(at(-6000));
	assert.ok(e6 && !acceptEntry(e6, alive), '6 s before start');
	const recycled = one(at(-3 * 3600_000));
	assert.ok(recycled && !acceptEntry(recycled, alive), 'old entry, new process');
	assert.ok(e6 && acceptEntry(e6, { alive: true }), 'unknown start');
	assert.ok(e60 && !acceptEntry(e60, { alive: false }), 'dead');
});

test('microsecond timestamps parse', () => {
	assert.equal(
		one('2026-09-18T12:18:19.040760Z')?.openedAt,
		Date.parse('2026-09-18T12:18:19.040Z'),
	);
});

test('malformed, oversized and non-array documents are unusable', () => {
	assert.equal(parseIndex(encodeUtf8('[{"session_id":')), undefined);
	assert.equal(parseIndex(bytes({ session_id: ID })), undefined);
	assert.equal(parseIndex(new Uint8Array(INDEX_MAX_BYTES + 1)), undefined);
	assert.deepEqual(parseIndex(bytes([])), []);
});

test('invalid entries are dropped, not guessed', () => {
	const entries = parseIndex(
		bytes([
			{ session_id: 'not-a-uuid', pid: 1, cwd: '/a' },
			{ session_id: ID, pid: 0, cwd: '/a' },
			{ session_id: ID, pid: 1.5, cwd: '/a' },
			{ session_id: ID, pid: 1, cwd: '' },
			'junk',
			{ session_id: ID, pid: 7, cwd: '/ok' },
		]),
	);
	assert.deepEqual(entries, [{ sessionId: ID, pid: 7, cwd: '/ok' }]);
});

test('only allowed fields are read; extra ones are ignored and not required', () => {
	assert.deepEqual(allowedIndexFields, ['session_id', 'pid', 'cwd', 'opened_at']);
	const entries = parseIndex(
		bytes([{ session_id: ID, pid: 3, cwd: '/a', opened_at: at(0), token: 'secret', extra: 1 }]),
	);
	assert.deepEqual(entries, [{ sessionId: ID, pid: 3, cwd: '/a', openedAt: START }]);
});
