import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyActivity, reduceActivity } from '../../../src/core/activity.js';
import { encodeUtf8 } from '../../../src/helpers/bytes.js';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { AllYourAgents } from '../../../src/index.js';
import { replayEvents } from '../../../src/providers/grok-build/activity.js';
import { deriveStatus } from '../../../src/providers/grok-build/events.js';
import { allowedIndexFields } from '../../../src/providers/grok-build/index-file.js';
import { mapChatRecord } from '../../../src/providers/grok-build/journal.js';
import { listSessions } from '../../../src/providers/grok-build/list.js';
import { grokBuild } from '../../../src/providers/grok-build/provider.js';
import { knownPhases } from '../../../src/providers/grok-build/status.js';
import { parseMeta } from '../../../src/providers/grok-build/subagents.js';
import { fakeProcesses, sessionDir } from './home.js';

const dir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../test/fixtures/grok-build/1.0.34',
);
const SESSION = '01a0b546-2e0f-7b43-8ed1-79d3540935ed';

const read = (path: string) => readFileSync(join(dir, path), 'utf8');
const lines = (path: string) =>
	read(path)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as unknown);

/** Compare with the checked-in expectation; `AYA_UPDATE_FIXTURES=1` rewrites it. */
function expectSnapshot(name: string, actual: unknown): void {
	const path = join(dir, name);
	if (process.env.AYA_UPDATE_FIXTURES === '1' || !existsSync(path)) {
		writeFileSync(path, `${JSON.stringify(actual, null, '\t')}\n`);
	}
	assert.deepEqual(actual, JSON.parse(readFileSync(path, 'utf8')));
}

test('captured chat history maps to the expected events', () => {
	const state = {};
	const events = lines('session/chat_history.jsonl').flatMap((rec) =>
		mapChatRecord(rec, state).map(({ raw: _raw, ...rest }) => rest),
	);
	expectSnapshot('expected-mapping.json', events);
});

test('captured events replay to the expected activity and status', () => {
	const summarize = (records: unknown[]) => {
		const { state, facts } = replayEvents(records);
		let activity = emptyActivity();
		for (const fact of facts) activity = reduceActivity(activity, fact);
		return { status: deriveStatus(state), facts: facts.map((f) => f.type), activity };
	};
	const session = summarize(lines('session/events.jsonl'));
	const failed = summarize(lines('failed/events.jsonl'));
	assert.equal(failed.activity.lastTurn, 'failed');
	assert.equal(failed.activity.error, undefined);
	expectSnapshot('expected-activity.json', { session, failed });
});

test('captured phases are all known', () => {
	const phases = new Set<string>();
	for (const rec of lines('session/events.jsonl') as { type?: string; phase?: string }[]) {
		if (rec.type === 'phase_changed' && rec.phase) phases.add(rec.phase);
	}
	for (const phase of phases) assert.ok(knownPhases.includes(phase), phase);
	assert.ok(phases.has('permission_prompt'));
});

test('captured subagents: seeded at bind with their final statuses', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aya-grok-fx-'));
	try {
		cpSync(join(dir, 'session'), sessionDir(home, '/tmp/app', SESSION), { recursive: true });
		cpSync(join(dir, 'active_sessions.json'), join(home, 'active_sessions.json'));
		const index = JSON.parse(read('active_sessions.json')) as { pid: number }[];
		const procs = fakeProcesses(0);
		procs.set(index[0]?.pid ?? 0, true, 0);
		const aya = AllYourAgents({ providers: [grokBuild({ home })], processes: procs });
		const starts: string[] = [];
		aya.on('subagent:start', (s) => starts.push(s.id));
		await aya.start();
		const session = aya.running()[0];
		assert.ok(session);
		const subs = (await session.subagents())
			.map(({ transcript: _t, events: _e, startedAt: _s, endedAt: _x, ...rest }) => rest)
			.sort((a, b) => a.id.localeCompare(b.id));
		assert.deepEqual(starts, []);
		expectSnapshot('expected-subagents.json', {
			title: session.title,
			model: session.model,
			status: session.status,
			subagents: subs,
		});
		await aya.stop();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('captured cancelled subagent meta', () => {
	assert.equal(parseMeta(encodeUtf8(read('cancelled/meta.json')))?.status, 'cancelled');
});

test('captured summaries list as expected', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aya-grok-fx-'));
	try {
		cpSync(join(dir, 'session'), sessionDir(home, '/tmp/app', SESSION), { recursive: true });
		const ids = {
			failed: '01a0b545-efa7-72c0-bd71-03adb1537fe9',
			headless: '01a0b545-974a-78c2-9db5-79132dcc8877',
		};
		for (const [name, id] of Object.entries(ids)) {
			cpSync(join(dir, name), sessionDir(home, '/tmp/app', id), { recursive: true });
		}
		const listed = [];
		for await (const snap of listSessions(createLocalFs(), home)) listed.push(snap);
		listed.sort((a, b) => a.id.localeCompare(b.id));
		expectSnapshot('expected-listing.json', listed);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('compat: the captured index has only the allowed fields', () => {
	const index = JSON.parse(read('active_sessions.json')) as Record<string, unknown>[];
	assert.ok(index.length > 0);
	for (const entry of index)
		assert.deepEqual(Object.keys(entry).sort(), [...allowedIndexFields].sort());
});
