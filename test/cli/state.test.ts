import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveCounts, visibleRows } from '../../src/cli/rows.js';
import { applyEvent, applyKey, type Key, type ViewState } from '../../src/cli/state.js';
import { NOW, session, withSessions } from './fixtures.js';

const NAMED = new Set([
	'up',
	'down',
	'home',
	'end',
	'pageup',
	'pagedown',
	'enter',
	'escape',
	'backspace',
	'ctrl-c',
]);
const ids = (state: ViewState) => visibleRows(state).map((r) => r.id);
const press = (state: ViewState, ...keys: string[]) =>
	keys.reduce<ViewState>((s, k) => applyKey(s, NAMED.has(k) ? (k as Key) : { char: k }), state);

test('header counts by status', () => {
	const state = withSessions([
		session('a', { status: 'running' }),
		session('b', { status: 'idle' }),
	]);
	assert.deepEqual(liveCounts(state), { live: 2, running: 1, waiting: 0, idle: 1 });
	assert.equal(state.ready, true);
});

test('status change updates counts', () => {
	let state = withSessions([session('a', { status: 'running' })]);
	state = applyEvent(state, {
		type: 'session',
		name: 'status',
		session: session('a', { status: 'waiting' }),
	});
	assert.deepEqual(liveCounts(state), { live: 1, running: 0, waiting: 1, idle: 0 });
});

test('close removes the row but keeps it for the closed view', () => {
	let state = withSessions([session('a'), session('b')]);
	state = applyEvent(state, { type: 'session', name: 'close', session: session('a') });
	assert.deepEqual(ids(state), ['b']);
	assert.equal(liveCounts(state).live, 1);
	state = press(state, 'c');
	assert.deepEqual(ids(state).sort(), ['a', 'b']);
	assert.equal(state.sessions.get('a')?.closed, true);
	assert.equal(state.sessions.get('a')?.pid, undefined);
	assert.equal(liveCounts(state).live, 1);
});

test('ready keeps sessions closed earlier and drops rows that are not live', () => {
	let state = withSessions([session('a'), session('b')], { ready: false });
	assert.equal(state.ready, false);
	state = applyEvent(state, { type: 'session', name: 'close', session: session('a') });
	state = applyEvent(state, { type: 'ready', live: [session('c')] });
	assert.deepEqual([...state.sessions.keys()].sort(), ['a', 'c']);
});

test('last provider error is kept and dismissed by a key', () => {
	let state = withSessions([session('a')]);
	state = applyEvent(state, { type: 'error', provider: 'p1', message: 'one' });
	state = applyEvent(state, { type: 'error', provider: 'p2', message: 'two' });
	assert.deepEqual(state.lastError, { provider: 'p2', message: 'two' });
	state = press(state, 'x');
	assert.equal(state.lastError, undefined);
});

test('subagent events accumulate on the session', () => {
	let state = withSessions([session('a')]);
	const sub = {
		id: 's1',
		sessionId: 'a',
		type: 'Explore',
		status: 'running' as const,
		background: false,
	};
	state = applyEvent(state, {
		type: 'subagent',
		name: 'start',
		subagent: sub,
		session: session('a'),
	});
	state = applyEvent(state, {
		type: 'subagent',
		name: 'end',
		subagent: { ...sub, status: 'completed' },
		session: session('a'),
	});
	state = applyEvent(state, {
		type: 'subagents',
		sessionId: 'a',
		list: [{ ...sub, id: 's2', background: true }],
	});
	assert.deepEqual(
		state.sessions.get('a')?.subagents.map((s) => `${s.id}:${s.status}`),
		['s1:completed', 's2:running'],
	);
	state = applyEvent(state, { type: 'session', name: 'activity', session: session('a') });
	assert.equal(state.sessions.get('a')?.subagents.length, 2);
});

test('default order is waiting, running, idle, then newest first', () => {
	const state = withSessions([
		session('i', { status: 'idle' }),
		session('w', { status: 'waiting' }),
		session('r1', { status: 'running', updatedAt: NOW - 5000 }),
		session('r2', { status: 'running', updatedAt: NOW - 10 }),
	]);
	assert.deepEqual(ids(state), ['w', 'r2', 'r1', 'i']);
});

test('reverse and cycle sort', () => {
	let state = withSessions([
		session('i', { status: 'idle', title: 'b' }),
		session('w', { status: 'waiting', title: 'c' }),
		session('r', { status: 'running', title: 'a' }),
	]);
	state = press(state, 'r');
	assert.deepEqual(ids(state), ['i', 'r', 'w']);
	assert.equal(state.sort.desc, true);
	state = press(state, 's', 's', 's');
	assert.equal(state.sort.key, 'title');
	assert.deepEqual(ids(state), ['r', 'i', 'w']);
	state = press(state, '<');
	assert.equal(state.sort.key, 'harness');
	state = press(state, '>');
	assert.equal(state.sort.key, 'title');
});

test('movement keys', () => {
	const many = Array.from({ length: 40 }, (_, i) =>
		session(`s${String(i).padStart(2, '0')}`, { updatedAt: NOW - i }),
	);
	let state = withSessions(many, { rows: 13 });
	assert.equal(state.selectedIndex, 0);
	state = press(state, 'down', 'j');
	assert.equal(state.selectedIndex, 2);
	state = press(state, 'up', 'k', 'k');
	assert.equal(state.selectedIndex, 0);
	state = press(state, 'pagedown');
	assert.equal(state.selectedIndex, 10);
	assert.ok(state.scroll > 0);
	state = press(state, 'pageup');
	assert.equal(state.selectedIndex, 0);
	state = press(state, 'end');
	assert.equal(state.selectedIndex, 39);
	assert.equal(state.scroll, 30);
	state = press(state, 'home');
	assert.equal(state.selectedIndex, 0);
	assert.equal(state.scroll, 0);
});

test('selection follows the session when rows reorder', () => {
	let state = withSessions([session('a', { status: 'running' }), session('b', { status: 'idle' })]);
	state = press(state, 'down');
	assert.equal(state.selectedId, 'b');
	state = applyEvent(state, {
		type: 'session',
		name: 'create',
		session: session('w', { status: 'waiting' }),
	});
	assert.equal(state.selectedId, 'b');
	assert.equal(state.selectedIndex, 2);
	state = press(state, 'r');
	assert.equal(state.selectedId, 'b');
	assert.equal(state.selectedIndex, 0);
});

test('selected session closing moves selection to the nearest row', () => {
	let state = withSessions([
		session('a', { status: 'waiting' }),
		session('b', { status: 'running' }),
		session('c', { status: 'idle' }),
	]);
	state = press(state, 'end');
	assert.equal(state.selectedId, 'c');
	state = applyEvent(state, { type: 'session', name: 'close', session: session('c') });
	assert.equal(state.selectedId, 'b');
});

test('enter toggles detail, escape closes it', () => {
	let state = withSessions([session('a')]);
	state = press(state, 'enter');
	assert.equal(state.detail, true);
	state = press(state, 'enter');
	assert.equal(state.detail, false);
	state = press(state, 'enter', 'escape');
	assert.equal(state.detail, false);
	assert.equal(press(withSessions([]), 'enter').detail, false);
});

test('filter prompt matches title, cwd, harness, model and pid', () => {
	let state = withSessions([
		session('a', { cwd: '/code/api' }),
		session('b', { cwd: '/code/web', model: 'opus-5' }),
		session('c', { cwd: '/code/cli', pid: 4242 }),
	]);
	state = press(state, '/', 'A', 'P', 'I');
	assert.equal(state.prompt, 'API');
	state = press(state, 'backspace', 'I', 'enter');
	assert.equal(state.prompt, undefined);
	assert.deepEqual(ids(state), ['a']);
	state = press(state, 'escape');
	assert.equal(state.filter, '');
	assert.equal(ids(state).length, 3);
	assert.deepEqual(ids(press(state, '/', 'o', 'p', 'u', 's', 'enter')), ['b']);
	assert.deepEqual(ids(press(state, '/', '4', '2', '4', 'enter')), ['c']);
	assert.equal(ids(press(state, '/', 'c', 'l', 'a', 'u', 'd', 'e', 'enter')).length, 3);
	const cancelled = press(state, '/', 'x', 'escape');
	assert.equal(cancelled.filter, '');
	assert.equal(cancelled.prompt, undefined);
	assert.equal(press(state, '/', 'q').quit, false);
});

test('help toggles and quit keys', () => {
	let state = withSessions([session('a')]);
	state = press(state, '?');
	assert.equal(state.help, true);
	assert.equal(press(state, 'down').selectedIndex, 0);
	state = press(state, 'h');
	assert.equal(state.help, false);
	assert.equal(press(state, 'h', 'escape').help, false);
	assert.equal(press(state, 'q').quit, true);
	assert.equal(press(state, '?', 'q').quit, true);
	assert.equal(press(state, 'ctrl-c').quit, true);
	assert.equal(press(state, '/', 'ctrl-c').quit, true);
});

test('resize re-anchors scroll', () => {
	const many = Array.from({ length: 30 }, (_, i) => session(`s${String(i).padStart(2, '0')}`));
	let state = press(withSessions(many, { rows: 40 }), 'end');
	state = applyEvent(state, { type: 'resize', cols: 80, rows: 10 });
	assert.equal(state.rows, 10);
	assert.equal(state.scroll, 30 - 7);
});
