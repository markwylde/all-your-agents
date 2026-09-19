import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fit, sanitize, stripAnsi, style, truncate, width } from '../../src/cli/ansi.js';
import { toKey } from '../../src/cli/keys.js';
import { renderLines } from '../../src/cli/render.js';
import { applyEvent, applyKey } from '../../src/cli/state.js';
import { formatJson, formatTable } from '../../src/cli/table.js';
import type { Session } from '../../src/index.js';
import { NOW, session, withSessions } from './fixtures.js';

const opts = { now: NOW, color: false, home: '/home/me' };

test('ansi: strip, truncate, width, sanitize', () => {
	assert.equal(stripAnsi(style('hi', ['bold', 'red'], true)), 'hi');
	assert.equal(style('hi', ['bold'], false), 'hi');
	assert.equal(truncate('hello world', 5), 'hell…');
	assert.equal(truncate('hello', 5), 'hello');
	assert.equal(truncate('hello', 0), '');
	assert.equal(width('日本'), 4);
	assert.equal(width('é'), 1);
	assert.equal(width(truncate('日本語テキスト', 5)), 5);
	assert.equal(fit('ab', 4, 'right'), '  ab');
	assert.equal(fit('日本語', 4), '日… ');
	assert.equal(sanitize('a\x1b[2Jb\nc'), 'a [2Jb c');
});

test('keys: readline keypresses map to view keys', () => {
	assert.equal(toKey(undefined, { name: 'up' }), 'up');
	assert.equal(toKey('\r', { name: 'return' }), 'enter');
	assert.equal(toKey('\x03', { name: 'c', ctrl: true }), 'ctrl-c');
	assert.deepEqual(toKey('q', { name: 'q' }), { char: 'q' });
	assert.deepEqual(toKey('?', { name: undefined, sequence: '?' }), { char: '?' });
	assert.equal(toKey('\x01', { name: 'a', ctrl: true }), undefined);
	// What Node's keypress decoder actually emits for a lone Esc byte.
	assert.equal(
		toKey(undefined, { sequence: '\x1b', name: 'escape', ctrl: false, meta: true }),
		'escape',
	);
	assert.equal(toKey('x', { name: 'x', meta: true, sequence: '\x1bx' }), undefined);
});

const sample = () =>
	withSessions([
		session('a', {
			status: 'running',
			title: 'Add CSV export to the reporting API with streaming',
			cwd: '/home/me/code/api',
			model: 'claude-opus-5',
			activity: { openSubagents: 2, tool: { id: 't', name: 'Bash' }, lastTurn: 'completed' },
		}),
		session('b', { status: 'waiting', title: '日本語のタイトル', waitingFor: 'approve Bash' }),
		session('c', { status: 'idle', title: undefined, model: undefined, updatedAt: undefined }),
	]);

for (const cols of [60, 100, 160]) {
	test(`render fits ${cols} columns`, () => {
		const state = applyEvent(sample(), { type: 'resize', cols, rows: 12 });
		for (const color of [false, true]) {
			const lines = renderLines(state, { ...opts, color });
			assert.equal(lines.length, 12);
			for (const line of lines) assert.ok(width(stripAnsi(line)) <= cols, `${cols}: ${line}`);
		}
		const lines = renderLines(state, opts);
		assert.match(lines[0] ?? '', /3 live {2}1 waiting {2}1 running {2}1 idle/);
		assert.match(lines[1] ?? '', /STATUS▲/);
		assert.match(lines[2] ?? '', /^> waiting/);
		assert.match(lines[3] ?? '', /running/);
		assert.match(lines[4] ?? '', /idle\s+\d+\s+(ClaudeCode\s+)?-/);
		if (cols >= 100) {
			assert.match(lines[0] ?? '', /updated 14:32:07/);
			assert.match(lines[1] ?? '', /FOLDER/);
			assert.match(lines[3] ?? '', /~\/code\/api/);
			assert.match(lines[3] ?? '', /Bash/);
		}
		if (cols >= 160) {
			assert.match(lines[1] ?? '', /HARNESS/);
			assert.match(lines[3] ?? '', /completed/);
			assert.match(lines[3] ?? '', /14:32:06/);
		}
		if (cols === 60) assert.doesNotMatch(lines[1] ?? '', /HARNESS|MODEL/);
	});
}

test('render shows loading before ready', () => {
	const state = withSessions([session('a')], { ready: false });
	assert.match(renderLines(state, opts)[0] ?? '', /loading/);
	assert.doesNotMatch(renderLines(state, opts)[0] ?? '', /live/);
});

test('render shows filter counts, closed rows, sort direction, and errors', () => {
	let state = sample();
	for (const ch of '/api') state = applyKey(state, { char: ch });
	state = applyKey(state, 'enter');
	let lines = renderLines(state, opts);
	assert.match(lines[0] ?? '', /filter: api 1\/3/);

	state = applyEvent(sample(), { type: 'session', name: 'close', session: session('c') });
	state = applyKey(applyKey(state, { char: 'c' }), { char: 'r' });
	lines = renderLines(state, opts);
	assert.match(lines[1] ?? '', /STATUS▼/);
	assert.ok(lines.some((l) => /^\s+closed/.test(l)));
	assert.match(lines[0] ?? '', /2 live/);

	state = applyEvent(state, { type: 'error', origin: 'claude-code', message: 'boom\x1b[2J' });
	lines = renderLines(state, opts);
	assert.equal(lines.at(-1), ' error [claude-code] boom [2J');
});

test('render shows empty and no-match states', () => {
	assert.match(renderLines(withSessions([]), opts)[2] ?? '', /No agents running/);
});

test('detail shows session facts and subagents', () => {
	let state = sample();
	state = applyKey(state, 'down');
	assert.equal(state.selectedId, 'a');
	state = applyKey(state, 'enter');
	for (const [id, status] of [
		['s1', 'running'],
		['s2', 'completed'],
	] as const) {
		state = applyEvent(state, {
			type: 'subagent',
			name: 'start',
			subagent: {
				id,
				sessionId: 'a',
				type: 'Explore',
				title: `find ${id}`,
				status,
				background: id === 's1',
			},
			session: session('a'),
		});
	}
	const text = renderLines(applyEvent(state, { type: 'resize', cols: 100, rows: 30 }), opts).join(
		'\n',
	);
	assert.match(text, /Session\s+a/);
	assert.match(text, /Folder\s+\/home\/me\/code\/api/);
	assert.match(text, /Subagents \(2\)/);
	assert.match(text, /running\s+Explore\s+find s1\s+background/);
	assert.match(text, /completed\s+Explore\s+find s2/);
});

test('detail shows waitingFor and wraps long titles', () => {
	let state = applyKey(sample(), 'enter');
	state = applyEvent(state, { type: 'resize', cols: 30, rows: 30 });
	const lines = renderLines(state, opts);
	assert.ok(lines.some((l) => /Waiting for\s+approve Bash/.test(l)));
	for (const line of lines) assert.ok(width(line) <= 30);
});

test('a background wait counts as waiting and its detail names the shell', () => {
	const state = withSessions([
		session('s', {
			status: 'waiting',
			waitingFor: 'shell',
			activity: { openSubagents: 0, lastTurn: 'completed' },
		}),
		session('i', { status: 'idle' }),
	]);
	const lines = renderLines(state, opts);
	assert.match(lines[0] ?? '', /2 live {2}1 waiting {2}0 running {2}1 idle/);
	assert.match(lines[2] ?? '', /^> waiting/);
	const detail = renderLines(applyKey(state, 'enter'), opts);
	assert.ok(detail.some((l) => /Waiting for\s+shell/.test(l)));
});

test('help overlay lists keys', () => {
	const text = renderLines(applyKey(sample(), { char: '?' }), opts).join('\n');
	for (const k of ['Enter', 'Filter', 'Reverse', 'closed sessions', 'Quit'])
		assert.ok(text.includes(k), k);
});

const asSession = (s: ReturnType<typeof session>) => s as unknown as Session;

test('plain table has a header and one row per session, no escapes', () => {
	const out = formatTable(
		[asSession(session('i', { status: 'idle' })), asSession(session('w', { status: 'waiting' }))],
		{ now: NOW, color: false, home: '/home/me' },
	);
	const lines = out.trimEnd().split('\n');
	assert.equal(lines.length, 3);
	assert.match(lines[0] ?? '', /^STATUS\s+PID\s+HARNESS\s+TITLE\s+FOLDER/);
	assert.match(lines[1] ?? '', /^waiting/);
	assert.match(lines[2] ?? '', /^idle .*~\/i/);
	assert.ok(!out.includes('\x1b'));
	assert.ok(formatTable([], { now: NOW, color: true }).includes('\x1b[1m'));
});

test('json lists the documented fields', () => {
	assert.equal(formatJson([]), '[]\n');
	const [row] = JSON.parse(
		formatJson([asSession(session('a', { waitingFor: 'x', kind: 'headless' }))]),
	);
	assert.deepEqual(Object.keys(row).sort(), [
		'activity',
		'cwd',
		'harness',
		'id',
		'kind',
		'pid',
		'provider',
		'status',
		'title',
		'updatedAt',
		'waitingFor',
	]);
});
