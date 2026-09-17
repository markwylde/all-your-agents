import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripAnsi, width } from '../../src/cli/ansi.js';
import { parseArgs, USAGE } from '../../src/cli/args.js';
import { renderLines } from '../../src/cli/render.js';
import { liveCounts, visibleRows } from '../../src/cli/rows.js';
import { applyEvent, applyKey, initialState, type ViewState } from '../../src/cli/state.js';
import { formatJson, formatTable } from '../../src/cli/table.js';
import type { Session } from '../../src/index.js';
import { NOW, session, withSessions } from './fixtures.js';

const opts = { now: NOW, color: false, home: '/home/me' };
const ids = (state: ViewState) => visibleRows(state).map((r) => r.id);
const press = (state: ViewState, ...chars: string[]) =>
	chars.reduce<ViewState>(
		(s, c) => applyKey(s, c === 'enter' || c === 'escape' ? c : { char: c }),
		state,
	);

const old = (id: string, patch = {}) =>
	session(id, { pid: undefined, status: undefined, updatedAt: NOW - 86_400_000, ...patch });

test('H asks for history; the history event shows it dimmed beside live rows', () => {
	let state = withSessions([session('live', { status: 'running' })]);
	state = press(state, 'H');
	assert.equal(state.history, 'loading');
	assert.match(renderLines(state, opts)[0] ?? '', /loading history…/);

	state = applyEvent(state, { type: 'history', sessions: [old('y1'), old('y2')] });
	assert.equal(state.history, 'on');
	assert.deepEqual(ids(state), ['live', 'y1', 'y2']);
	assert.deepEqual(liveCounts(state), { live: 1, running: 1, waiting: 0, idle: 0 });
	const frame = renderLines(state, opts);
	assert.match(frame[0] ?? '', /1 live/);
	assert.match(frame[0] ?? '', /\+history \(2\)/);
	assert.match(frame.find((l) => l.includes('Session y1')) ?? '', /closed/);
	const colored = renderLines(state, { ...opts, color: true });
	assert.ok(
		colored.find((l) => l.includes('Session y1'))?.includes('\x1b[2m'),
		'history is dimmed',
	);
});

test('H again drops history rows and keeps sessions that closed during this run', () => {
	let state = withSessions([session('live'), session('gone')]);
	state = applyEvent(state, { type: 'session', name: 'close', session: session('gone') });
	state = press(state, 'c', 'H');
	state = applyEvent(state, { type: 'history', sessions: [old('y1')] });
	assert.deepEqual(new Set(ids(state)), new Set(['live', 'gone', 'y1']));
	state = press(state, 'H');
	assert.equal(state.history, 'off');
	assert.deepEqual(new Set(ids(state)), new Set(['live', 'gone']));
	assert.equal(state.sessions.has('y1'), false);
	// Without `c`, a session that closed during the run stays hidden while history is on.
	state = press(state, 'c', 'H');
	state = applyEvent(state, { type: 'history', sessions: [old('y1')] });
	assert.deepEqual(new Set(ids(state)), new Set(['live', 'y1']));
});

test('a live session that history also lists keeps its live row', () => {
	let state = press(withSessions([session('both', { status: 'running' })]), 'H');
	state = applyEvent(state, {
		type: 'history',
		sessions: [old('both', { title: 'from disk' }), old('y1')],
	});
	const row = state.sessions.get('both');
	assert.equal(row?.closed, false);
	assert.equal(row?.status, 'running');
	assert.equal(row?.title, 'Session both');
	assert.equal(visibleRows(state).filter((r) => r.id === 'both').length, 1);
});

test('a historical session that starts again becomes a live row', () => {
	let state = press(withSessions([]), 'H');
	state = applyEvent(state, { type: 'history', sessions: [old('y1')] });
	state = applyEvent(state, { type: 'session', name: 'open', session: session('y1') });
	assert.equal(state.sessions.get('y1')?.closed, false);
	assert.equal(state.sessions.get('y1')?.history, false);
	assert.equal(liveCounts(state).live, 1);
});

test('filter and sort span live and history rows; the header counts what is shown', () => {
	let state = press(withSessions([session('live', { cwd: '/w/api' })]), 'H');
	state = applyEvent(state, {
		type: 'history',
		sessions: [old('y1', { cwd: '/w/api-old' }), old('y2', { cwd: '/w/web' })],
	});
	state = press(state, '/', 'a', 'p', 'i', 'enter');
	assert.deepEqual(ids(state), ['live', 'y1']);
	assert.match(renderLines(state, opts)[0] ?? '', /filter: api 2\/3/);
});

test('a history result that arrives after H was switched off is dropped', () => {
	let state = press(withSessions([session('live')]), 'H', 'H');
	assert.equal(state.history, 'off');
	const after = applyEvent(state, { type: 'history', sessions: [old('y1')] });
	assert.equal(after, state);
	state = after;
	assert.deepEqual(ids(state), ['live']);
});

test('--history starts loading; ready keeps history rows', () => {
	let state = initialState({ cols: 100, rows: 20, history: true });
	assert.equal(state.history, 'loading');
	state = applyEvent(state, { type: 'history', sessions: [old('y1')] });
	state = applyEvent(state, { type: 'ready', live: [session('live')] });
	assert.deepEqual(new Set(ids(state)), new Set(['live', 'y1']));
});

test('detail works on a history row and takes its subagents', () => {
	let state = press(withSessions([]), 'H');
	state = applyEvent(state, { type: 'history', sessions: [old('y1')] });
	state = press(state, 'enter');
	state = applyEvent(state, {
		type: 'subagents',
		sessionId: 'y1',
		list: [
			{
				id: 's1',
				sessionId: 'y1',
				type: 'Explore',
				title: 'look',
				status: 'completed',
				background: false,
			},
			{
				id: 's2',
				sessionId: 'y1',
				type: 'Plan',
				title: 'plan',
				status: 'failed',
				background: true,
			},
		],
	});
	const text = renderLines(state, opts).join('\n');
	assert.match(text, /Subagents \(2\)/);
	assert.match(text, /completed\s+Explore/);
	assert.match(text, /failed\s+Plan/);
});

test('every frame with history fits the width, and help and usage list the new keys', () => {
	let state = press(withSessions([session('live')], { cols: 50, rows: 12 }), 'H');
	state = applyEvent(state, { type: 'history', sessions: [old('y1'), old('y2')] });
	for (const s of [state, press(state, '?'), press(state, 't')]) {
		for (const line of renderLines(s, opts)) assert.ok(width(stripAnsi(line)) <= 50, line);
	}
	const help = renderLines(press(withSessions([], { rows: 30 }), '?'), opts).join('\n');
	for (const needle of ['H  ', 't  ', 'history', 'Transcript'])
		assert.ok(help.includes(needle), needle);
	for (const needle of ['--history', ' H ', ' t ']) assert.ok(USAGE.includes(needle), needle);
});

test('--history is parsed', () => {
	const r = parseArgs(['--json', '--history']);
	assert.ok(r.ok);
	assert.deepEqual(r.args, {
		mode: 'json',
		all: false,
		history: true,
		help: false,
		version: false,
	});
});

const asSession = (like: ReturnType<typeof session>): Session => ({
	...like,
	transcript: async function* () {},
	events: () => ({ close() {}, async *[Symbol.asyncIterator]() {} }),
	subagents: async () => [],
});

test('one-shot history: live first by status, then the rest newest first, shown as closed', () => {
	const sessions = [
		asSession(old('older', { updatedAt: NOW - 3 * 86_400_000 })),
		asSession(session('idle', { status: 'idle' })),
		asSession(old('newer', { updatedAt: NOW - 86_400_000 })),
		asSession(session('waiting', { status: 'waiting' })),
		// Live without a pid: liveness comes from the instance, not from pid.
		asSession(session('nopid', { status: 'running', pid: undefined })),
	];
	const live = new Set(['idle', 'waiting', 'nopid']);
	const rows = formatTable(sessions, { ...opts, live })
		.trimEnd()
		.split('\n')
		.slice(1);
	assert.deepEqual(
		rows.map((r) => r.split(/\s+/)[0]),
		['waiting', 'running', 'idle', 'closed', 'closed'],
	);
	assert.match(rows[3] ?? '', /Session newer/);
	const json = JSON.parse(formatJson(sessions, live)) as { id: string; pid?: number }[];
	assert.deepEqual(
		json.map((s) => s.id),
		['waiting', 'nopid', 'idle', 'newer', 'older'],
	);
	assert.equal(json[3]?.pid, undefined);
	// Without a live set every session given is live, as before.
	assert.doesNotMatch(formatTable(sessions.slice(1, 2), opts), /closed/);
});
