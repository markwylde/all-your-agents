import assert from 'node:assert/strict';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyActivity, reduceActivity } from '../../../src/core/activity.js';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { AllYourAgents } from '../../../src/index.js';
import { deriveStatus, replayRecords } from '../../../src/providers/oh-my-pi/events.js';
import {
	mapRecord,
	ohMyPi,
	parseBreadcrumb,
	parsePresence,
} from '../../../src/providers/oh-my-pi/index.js';
import { listSessions } from '../../../src/providers/oh-my-pi/list.js';
import { resolveRoots } from '../../../src/providers/oh-my-pi/paths.js';
import { PERSISTED_ENTRY_TYPES } from '../../../src/providers/oh-my-pi/persisted-entries.js';
import { fakeOmpProcesses, STAMP, sessionPath } from './home.js';

const dir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../test/fixtures/oh-my-pi/18.2',
);

const IDS = {
	root: '00000000-0000-4000-8000-0000000000f1',
	nested: '00000000-0000-4000-8000-0000000000b1',
	'ask-wait': '00000000-0000-4000-8000-0000000000a1',
	'error-turn': '00000000-0000-4000-8000-0000000000e1',
	'print-mode': '00000000-0000-4000-8000-0000000000e2',
	'aborted-turn.synthetic': '00000000-0000-4000-8000-0000000000ab',
} as const;

const read = (name: string) => readFileSync(join(dir, name), 'utf8');
const records = (name: string) =>
	read(name)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as unknown);

function walk(at: string): string[] {
	return readdirSync(at).flatMap((name) => {
		const full = join(at, name);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

function expectSnapshot(name: string, actual: unknown): void {
	const path = join(dir, name);
	if (process.env.AYA_UPDATE_FIXTURES === '1' || !existsSync(path)) {
		writeFileSync(path, `${JSON.stringify(actual, null, '\t')}\n`);
	}
	assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(readFileSync(path, 'utf8')));
}

function slim(event: { kind: string } & Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { kind: event.kind };
	for (const key of [
		'id',
		'name',
		'model',
		'outcome',
		'message',
		'status',
		'type',
		'source',
		'isError',
		'background',
	]) {
		if (key in event && event[key] !== undefined) out[key] = event[key];
	}
	return out;
}

/** The fixtures laid out as omp lays them out, under a temporary home. */
function install(home: string): void {
	for (const [name, id] of Object.entries(IDS)) {
		const dest = sessionPath(home, id, '/home/u/proj');
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(join(dir, `${name}.jsonl`), dest);
		const children = join(dir, `${name}.children`);
		if (existsSync(children))
			cpSync(children, dest.slice(0, -'.jsonl'.length), { recursive: true });
	}
}

test('captured fixtures hold no home path, prompt text or credential material', () => {
	for (const file of walk(dir)) {
		const text = readFileSync(file, 'utf8');
		assert.equal(/\/Users\/|\/private\/tmp|omp-watch/.test(text), false, file);
		assert.equal(/ighthouse|colour|Signature|providerPayload|"hash"/.test(text), false, file);
	}
});

test('every captured entry type is one we know omp persists', () => {
	const seen = new Set<string>();
	for (const file of walk(dir).filter((f) => f.endsWith('.jsonl'))) {
		for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
			seen.add((JSON.parse(line) as { type: string }).type);
		}
	}
	for (const type of seen)
		assert.ok((PERSISTED_ENTRY_TYPES as readonly string[]).includes(type), type);
});

test('captured transcripts map to the expected events', () => {
	const out: Record<string, unknown> = {};
	for (const name of Object.keys(IDS)) {
		const state = {};
		out[name] = records(`${name}.jsonl`).flatMap((rec) => mapRecord(rec, state).map(slim));
	}
	expectSnapshot('expected-events.json', out);
});

test('captured transcripts replay to the expected activity', () => {
	const out: Record<string, unknown> = {};
	for (const name of Object.keys(IDS)) {
		const { state, facts } = replayRecords(records(`${name}.jsonl`));
		let activity = emptyActivity();
		for (const fact of facts) activity = reduceActivity(activity, fact);
		out[name] = {
			status: deriveStatus(state),
			facts: facts.map((f) => f.type),
			activity,
			model: state.model,
		};
	}
	expectSnapshot('expected-activity.json', out);
});

test('the ask wait is visible at the point omp was blocked', () => {
	const all = records('ask-wait.jsonl');
	const blockedAt = all.findIndex(
		(rec) =>
			(rec as { customType?: string; data?: { toolName?: string } }).data?.toolName === 'ask',
	);
	assert.ok(blockedAt > 0);
	const { state } = replayRecords(all.slice(0, blockedAt + 1));
	assert.deepEqual(deriveStatus(state), { status: 'waiting', waitingFor: 'ask' });
});

test('captured fixtures list as expected, children excluded', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aya-omp-fx-'));
	try {
		install(home);
		const fs = createLocalFs();
		const listed = await listSessions(fs, await resolveRoots(fs, { home }));
		expectSnapshot(
			'expected-listing.json',
			listed.map(({ updatedAt: _u, ...rest }) => rest).sort((a, b) => a.id.localeCompare(b.id)),
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('captured subagents: types, nesting and final statuses, from history alone', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aya-omp-fx-'));
	try {
		install(home);
		const aya = AllYourAgents({ providers: [ohMyPi({ home })], processes: fakeOmpProcesses() });
		const out: Record<string, unknown> = {};
		for (const name of ['root', 'nested'] as const) {
			const session = await aya.get(IDS[name]);
			const subs = (await session?.subagents()) ?? [];
			out[name] = subs
				.map((s) => ({
					id: s.id,
					title: s.title,
					type: s.type,
					parentId: s.parentId,
					status: s.status,
				}))
				.sort((a, b) => a.id.localeCompare(b.id));
		}
		expectSnapshot('expected-subagents.json', out);
		assert.equal(STAMP.length > 0, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('compat: the registry files and the fields we read from them', () => {
	assert.deepEqual(parsePresence(read('presence.json')), {
		pid: 18510,
		projectDir: '/home/u/proj',
	});
	const fresh = parseBreadcrumb(read('breadcrumb-fresh'));
	assert.equal(fresh?.fresh, true);
	assert.equal(fresh?.sessionId, IDS.root);
	assert.equal(parseBreadcrumb(read('breadcrumb'))?.fresh, false);
	const header = records('root.jsonl')[1] as Record<string, unknown>;
	for (const key of ['type', 'version', 'id', 'timestamp', 'cwd']) assert.ok(key in header, key);
	const childHeader = records('root.children/PowTwoTen.jsonl')[1] as Record<string, unknown>;
	assert.equal(typeof childHeader.parentSession, 'string');
	const history = JSON.parse(read('history.json')) as {
		schema: string;
		rows: Record<string, unknown>[];
	};
	for (const column of ['id', 'prompt', 'created_at', 'session_id']) {
		assert.ok(history.schema.includes(column), column);
	}
	assert.ok(history.rows.length > 0);
});
