import assert from 'node:assert/strict';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyActivity, reduceActivity } from '../../../src/core/activity.js';
import { encodeUtf8 } from '../../../src/helpers/bytes.js';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { replayRecords } from '../../../src/providers/codex-cli/activity.js';
import { deriveStatus } from '../../../src/providers/codex-cli/events.js';
import { mapRecord } from '../../../src/providers/codex-cli/journal.js';
import { listSessions } from '../../../src/providers/codex-cli/list.js';
import {
	allowedMetaFields,
	parseSessionMeta,
} from '../../../src/providers/codex-cli/session-meta.js';
import { rolloutPath } from './home.js';

const dir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../test/fixtures/codex-cli/0.154',
);

const ROOT = '00000000-0000-4000-8000-0000000000f1';
const CHILD = '00000000-0000-4000-8000-0000000000c1';
const EXEC = '00000000-0000-4000-8000-0000000000e1';

const read = (name: string) => readFileSync(join(dir, name), 'utf8');
const lines = (name: string) =>
	read(name)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as unknown);

function expectSnapshot(name: string, actual: unknown): void {
	const path = join(dir, name);
	if (process.env.AYA_UPDATE_FIXTURES === '1' || !existsSync(path)) {
		writeFileSync(path, `${JSON.stringify(actual, null, '\t')}\n`);
	}
	assert.deepEqual(actual, JSON.parse(readFileSync(path, 'utf8')));
}

function slim(event: { kind: string } & Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { kind: event.kind };
	if ('text' in event) out.text = event.text;
	if ('id' in event) out.id = event.id;
	if ('name' in event) out.name = event.name;
	if ('outcome' in event) out.outcome = event.outcome;
	if ('message' in event) out.message = event.message;
	if ('status' in event) out.status = event.status;
	return out;
}

test('captured fixture maps to expected events; no home paths or encrypted_content', () => {
	const raw = `${read('root.jsonl')}${read('child-sartre.jsonl')}${read('exec.jsonl')}${read('session_index.jsonl')}`;
	assert.equal(/\/Users\//.test(raw), false);
	assert.equal(/encrypted_content/.test(raw), false);
	const events = lines('root.jsonl').flatMap((rec) => mapRecord(rec).map(slim));
	expectSnapshot('expected-events.json', events);
});

test('captured fixture replays to expected activity', () => {
	const { state, facts } = replayRecords(lines('root.jsonl'));
	let activity = emptyActivity();
	for (const fact of facts) activity = reduceActivity(activity, fact);
	expectSnapshot('expected-activity.json', {
		status: deriveStatus(state),
		facts: facts.map((f) => f.type),
		activity,
	});
});

test('captured fixtures list as expected', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aya-codex-fx-'));
	try {
		const stamp = '2026-01-01T00-00-00';
		const copy = (from: string, dest: string) => {
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(join(dir, from), dest);
		};
		copy('root.jsonl', rolloutPath(home, ROOT, stamp));
		copy('child-sartre.jsonl', rolloutPath(home, CHILD, '2026-01-01T00-00-13'));
		copy('exec.jsonl', rolloutPath(home, EXEC, '2026-01-01T00-00-20'));
		cpSync(join(dir, 'session_index.jsonl'), join(home, 'session_index.jsonl'));
		const listed = [...(await listSessions(createLocalFs(), home))].sort((a, b) =>
			a.id.localeCompare(b.id),
		);
		expectSnapshot(
			'expected-listing.json',
			listed.map(({ updatedAt: _u, ...rest }) => rest),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('captured child is a subagent, not a root; meta fields are allowed', () => {
	const child = parseSessionMeta(encodeUtf8(read('child-sartre.jsonl')));
	assert.equal(child?.root, false);
	assert.equal(child?.agentNickname, 'Sartre');
	const root = parseSessionMeta(encodeUtf8(read('root.jsonl')));
	assert.ok(root);
	for (const key of Object.keys(
		JSON.parse(read('root.jsonl').split('\n')[0] ?? '{}').payload as Record<string, unknown>,
	)) {
		assert.ok(allowedMetaFields.includes(key as (typeof allowedMetaFields)[number]), key);
	}
	expectSnapshot('expected-subagents.json', {
		id: child?.id,
		title: child?.agentNickname,
		parent: child?.parentThreadId,
		root: child?.root,
	});
});
