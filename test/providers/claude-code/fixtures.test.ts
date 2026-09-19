import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyActivity, reduceActivity } from '../../../src/core/activity.js';
import { turnFactsFromRecord } from '../../../src/providers/claude-code/activity.js';
import { mapRecord } from '../../../src/providers/claude-code/journal.js';
import { allowedSessionFields } from '../../../src/providers/claude-code/session-file.js';

const dir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../test/fixtures/claude-code/2.1',
);

test('captured journal mapping matches expected kinds', () => {
	const lines = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n');
	const kinds = lines.flatMap((line) => mapRecord(JSON.parse(line)).map((e) => e.kind));
	const expected = JSON.parse(readFileSync(join(dir, 'expected-mapping.json'), 'utf8')) as string[];
	assert.deepEqual(kinds, expected);
});

test('compat: session file allowed fields', () => {
	const files = ['session.json', 'session-spare.json', 'session-job.json', 'session-parked.json'];
	for (const name of files) {
		const session = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
		for (const key of Object.keys(session)) {
			assert.ok(allowedSessionFields.includes(key), `unexpected field ${key} in ${name}`);
		}
	}
});

test('activity from captured journal', () => {
	const lines = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n');
	let activity = emptyActivity();
	for (const line of lines) {
		for (const fact of turnFactsFromRecord(JSON.parse(line))) {
			activity = reduceActivity(activity, fact);
		}
	}
	assert.equal(activity.lastTurn, 'interrupted');
});

test('fixtures contain no home path', () => {
	const text =
		readFileSync(join(dir, 'journal.jsonl'), 'utf8') +
		readFileSync(join(dir, 'session.json'), 'utf8');
	assert.equal(text.includes('/Users/mark'), false);
});
