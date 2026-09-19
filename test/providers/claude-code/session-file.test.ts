import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeUtf8 } from '../../../src/helpers/bytes.js';
import {
	parseSessionFile,
	SESSION_FILE_MAX_BYTES,
} from '../../../src/providers/claude-code/session-file.js';

const id = '7c30d9ac-21d5-4175-bc1f-70c128f5478f';
const start = 1_000_000;

function file(over: Record<string, unknown> = {}) {
	return encodeUtf8(
		JSON.stringify({
			pid: 123,
			sessionId: id,
			cwd: '/tmp/app',
			startedAt: start,
			status: 'idle',
			...over,
		}),
	);
}

test('accepts matching pid and start time within 4s', () => {
	const parsed = parseSessionFile(123, file({ startedAt: start + 4000 }), {
		alive: true,
		startTime: start,
	});
	assert.equal(parsed?.sessionId, id);
});

test('rejects 6s start-time mismatch', () => {
	assert.equal(
		parseSessionFile(123, file({ startedAt: start + 6000 }), { alive: true, startTime: start }),
		undefined,
	);
});

test('recycled pid hours later is rejected', () => {
	assert.equal(
		parseSessionFile(123, file({ startedAt: start }), {
			alive: true,
			startTime: start + 3_600_000,
		}),
		undefined,
	);
});

test('pid mismatch is rejected', () => {
	assert.equal(
		parseSessionFile(123, file({ pid: 456 }), { alive: true, startTime: start }),
		undefined,
	);
});

test('unknown start time with live process is accepted', () => {
	assert.equal(parseSessionFile(123, file(), { alive: true })?.sessionId, id);
});

test('malformed JSON is rejected', () => {
	assert.equal(
		parseSessionFile(123, encodeUtf8('{'), { alive: true, startTime: start }),
		undefined,
	);
});

test('oversized file is rejected', () => {
	const big = encodeUtf8(
		`{"pid":123,"sessionId":"${id}","pad":"${'x'.repeat(SESSION_FILE_MAX_BYTES)}"}`,
	);
	assert.equal(parseSessionFile(123, big, { alive: true, startTime: start }), undefined);
});

test('daemon fields are kept when well typed', () => {
	const parsed = parseSessionFile(
		123,
		file({ spare: true, jobId: 'e32386cc', parkedJobId: '7a6f4abc' }),
		{ alive: true, startTime: start },
	);
	assert.equal(parsed?.spare, true);
	assert.equal(parsed?.jobId, 'e32386cc');
	assert.equal(parsed?.parkedJobId, '7a6f4abc');
});

test('mistyped daemon fields are ignored', () => {
	const parsed = parseSessionFile(123, file({ spare: 'yes', jobId: 7, parkedJobId: '' }), {
		alive: true,
		startTime: start,
	});
	assert.equal(parsed?.sessionId, id);
	assert.equal(parsed?.spare, undefined);
	assert.equal(parsed?.jobId, undefined);
	assert.equal(parsed?.parkedJobId, undefined);
});
