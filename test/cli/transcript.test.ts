import assert from 'node:assert/strict';
import { test } from 'node:test';
import { width } from '../../src/cli/ansi.js';
import { renderLines } from '../../src/cli/render.js';
import { applyEvent, applyKey, bodyHeight, type Key, type ViewState } from '../../src/cli/state.js';
import { createItemizer, type TranscriptItem, transcriptLines } from '../../src/cli/transcript.js';
import type { SessionEvent } from '../../src/index.js';
import { NOW, session, withSessions } from './fixtures.js';

const opts = { now: NOW, color: false, home: '/home/me' };
const AT = new Date(2026, 8, 17, 14, 31, 2).getTime();

const press = (state: ViewState, ...keys: (Key | string)[]) =>
	keys.reduce<ViewState>(
		(s, k) => applyKey(s, typeof k === 'string' && k.length === 1 ? { char: k } : (k as Key)),
		state,
	);

const text = (items: TranscriptItem[], cols = 60) =>
	transcriptLines(items, cols).map((l) => l.text);

test('itemizer keeps what the view shows and drops the rest', () => {
	const itemize = createItemizer();
	const events: SessionEvent[] = [
		{ kind: 'title', title: 'x', source: 'harness', raw: {} },
		{ kind: 'user', text: 'fix the bug', at: AT, raw: { big: 'record' } },
		{ kind: 'assistant', text: 'Looking.', model: 'claude-opus-5', at: AT, raw: {} },
		{ kind: 'tool', id: 't1', name: 'Bash', raw: {} },
		{ kind: 'tool-result', id: 't1', isError: false, raw: {} },
		{ kind: 'tool', id: 't2', name: 'Edit', raw: {} },
		{ kind: 'tool-result', id: 't2', isError: true, raw: {} },
		{
			kind: 'subagent',
			id: 'a1',
			type: 'Explore',
			title: 'find callers',
			background: true,
			raw: {},
		},
		{ kind: 'error', message: 'API error', raw: {} },
		{ kind: 'turn-end', outcome: 'failed', raw: {} },
		{ kind: 'turn-end', outcome: 'completed', raw: {} },
		{ kind: 'other', raw: {} },
	];
	const items = events.flatMap(itemize);
	assert.deepEqual(
		items.map((i) => `${i.kind}:${i.text}`),
		[
			'user:fix the bug',
			'assistant:Looking.',
			'tool:Bash',
			'tool:Edit',
			'tool-failed:Edit',
			'subagent:Explore: find callers (background)',
			'error:API error',
			'turn-end:failed',
		],
	);
	assert.equal(items[1]?.note, 'claude-opus-5');
	assert.equal(JSON.stringify(items).includes('record'), false, 'raw records are not kept');
	// A new turn can end again.
	assert.equal(itemize({ kind: 'user', text: 'again', raw: {} }).length, 1);
	assert.equal(itemize({ kind: 'turn-end', raw: {} })[0]?.text, 'completed');
});

test('lines: speakers, times, tools, outcome', () => {
	const lines = text([
		{ kind: 'user', text: 'fix the bug', at: AT },
		{ kind: 'assistant', text: 'Looking.', at: AT, note: 'claude-opus-5' },
		{ kind: 'tool', text: 'Bash' },
		{ kind: 'assistant', text: 'Done.' },
		{ kind: 'tool-failed', text: 'Edit' },
		{ kind: 'turn-end', text: 'completed', at: AT },
		{ kind: 'user', text: 'thanks' },
	]);
	assert.deepEqual(lines, [
		' You · 14:31:02',
		'   fix the bug',
		' Agent · claude-opus-5 · 14:31:02',
		'   Looking.',
		'   ⚙ Bash',
		'   Done.',
		'   ✗ Edit failed',
		' ── completed · 14:31:02',
		'',
		' You',
		'   thanks',
	]);
});

test('lines: wraps on words, keeps paragraphs, cuts long tokens, never exceeds the width', () => {
	const long = `${'word '.repeat(30)}\n\n\n${'x'.repeat(100)}\n\tindented 日本語のテキスト ${'日本'.repeat(30)}`;
	for (const cols of [20, 41, 80]) {
		const lines = text([{ kind: 'assistant', text: long }], cols);
		for (const line of lines) assert.ok(width(line) <= cols, `${cols}: "${line}"`);
		assert.equal(lines.filter((l) => l === '').length, 1, 'blank runs collapse to one');
		assert.equal(lines.join('').replace(/\s/g, '').includes('x'.repeat(100)), true);
	}
});

test('lines: control characters in a transcript are inert', () => {
	const lines = text([
		{ kind: 'assistant', text: 'a\x1b[2Jb\x07c\x9b31m', note: '\x1b]0;pwn\x07' },
	]);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
	for (const line of lines) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
});

test('lines: appending wraps only what is new, and a different list starts over', () => {
	const a: TranscriptItem = { kind: 'user', text: 'one' };
	const b: TranscriptItem = { kind: 'assistant', text: 'two' };
	const first = transcriptLines([a], 60);
	assert.equal(transcriptLines([a], 60), first, 'same input is remembered');
	const grown = transcriptLines([a, b], 60);
	assert.deepEqual(grown.slice(0, first.length), first);
	assert.deepEqual(
		grown.map((l) => l.text),
		[' You', '   one', ' Agent', '   two'],
	);
	assert.deepEqual(
		transcriptLines([b], 60).map((l) => l.text),
		[' Agent', '   two'],
	);
});

function opened(rows = 8) {
	let state = withSessions([session('a'), session('b')], { rows });
	state = press(state, 'down', 't');
	return state;
}

const many = (n: number): TranscriptItem[] =>
	Array.from({ length: n }, (_, i) => ({ kind: 'tool', text: `T${i}` }) as TranscriptItem);

test('t opens the transcript of the selected session at the end and follows', () => {
	let state = opened();
	assert.equal(state.transcript?.sessionId, state.selectedId);
	assert.match(renderLines(state, opts).join('\n'), /No records yet/);
	state = applyEvent(state, { type: 'transcript:append', sessionId: 'b', items: many(20) });
	const height = bodyHeight(state);
	const total = transcriptLines(state.transcript?.items ?? [], state.cols).length;
	assert.equal(state.transcript?.scroll, total - height);
	const frame = renderLines(state, opts);
	assert.match(frame[1] ?? '', /Transcript · Session b/);
	assert.match(frame.at(-2) ?? '', /T19/);
	assert.match(frame.at(-1) ?? '', /following/);
	// More arrives: still at the end.
	state = applyEvent(state, { type: 'transcript:append', sessionId: 'b', items: many(3) });
	assert.match(renderLines(state, opts).at(-2) ?? '', /T2$/);
});

test('scrolling up stops following; End follows again', () => {
	let state = opened();
	state = applyEvent(state, { type: 'transcript:append', sessionId: 'b', items: many(20) });
	state = press(state, 'up', 'k');
	assert.equal(state.transcript?.follow, false);
	const shown = renderLines(state, opts).slice(2, -1);
	state = applyEvent(state, { type: 'transcript:append', sessionId: 'b', items: many(5) });
	assert.deepEqual(renderLines(state, opts).slice(2, -1), shown, 'lines on screen do not move');
	assert.doesNotMatch(renderLines(state, opts).at(-1) ?? '', /following/);
	state = press(state, 'home');
	assert.equal(state.transcript?.scroll, 0);
	state = press(state, 'pagedown', 'pageup', 'up');
	assert.equal(state.transcript?.scroll, 0, 'clamped at the top');
	state = press(state, 'end');
	assert.equal(state.transcript?.follow, true);
	state = press(state, 'up', 'down');
	assert.equal(state.transcript?.follow, true, 'scrolling back down to the end follows again');
});

test('table keys are ignored in the transcript; t or Esc closes with the selection kept', () => {
	let state = opened();
	const before = { sort: state.sort, filter: state.filter, selectedId: state.selectedId };
	state = press(state, 's', 'r', '/', 'c', 'H', 'enter');
	assert.deepEqual(
		{ sort: state.sort, filter: state.filter, selectedId: state.selectedId },
		before,
	);
	assert.equal(state.prompt, undefined);
	assert.ok(state.transcript);
	assert.equal(press(state, 't').transcript, undefined);
	state = press(state, 'escape');
	assert.equal(state.transcript, undefined);
	assert.equal(state.selectedId, 'b');
	assert.equal(press(opened(), 'q').quit, true);
	assert.equal(press(opened(), '?').help, true);
});

test('appends for another session, or after closing, are dropped', () => {
	let state = opened();
	state = applyEvent(state, { type: 'transcript:append', sessionId: 'a', items: many(3) });
	assert.equal(state.transcript?.items.length, 0);
	state = press(state, 'escape');
	assert.equal(
		applyEvent(state, { type: 'transcript:append', sessionId: 'b', items: many(3) }),
		state,
	);
});

test('resize re-wraps and keeps the transcript in range', () => {
	let state = opened(30);
	const items: TranscriptItem[] = [{ kind: 'assistant', text: 'word '.repeat(400) }];
	state = applyEvent(state, { type: 'transcript:append', sessionId: 'b', items });
	state = press(state, 'home');
	state = applyEvent(state, { type: 'resize', cols: 40, rows: 10 });
	for (const line of renderLines(state, opts)) assert.ok(width(line) <= 40);
	state = press(state, 'end');
	state = applyEvent(state, { type: 'resize', cols: 200, rows: 50 });
	const total = transcriptLines(state.transcript?.items ?? [], 200).length;
	assert.equal(state.transcript?.scroll, Math.max(0, total - bodyHeight(state)));
});

test('t with nothing selected does nothing', () => {
	const state = withSessions([]);
	assert.equal(press(state, 't').transcript, undefined);
});
