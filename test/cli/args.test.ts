import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, USAGE } from '../../src/cli/args.js';

test('no flags opens the TUI', () => {
	assert.deepEqual(parseArgs([]), {
		ok: true,
		args: { mode: 'tui', all: false, help: false, version: false },
	});
});

test('each flag is recognised', () => {
	const ok = (argv: string[]) => {
		const r = parseArgs(argv);
		assert.ok(r.ok);
		return r.args;
	};
	assert.equal(ok(['--once']).mode, 'once');
	assert.equal(ok(['--json']).mode, 'json');
	assert.equal(ok(['--once', '--json']).mode, 'json');
	assert.equal(ok(['--json', '--once']).mode, 'json');
	assert.equal(ok(['--all']).all, true);
	assert.equal(ok(['--help']).help, true);
	assert.equal(ok(['--version']).version, true);
});

test('unknown flag is an error', () => {
	const r = parseArgs(['--bogus']);
	assert.equal(r.ok, false);
	assert.match(r.ok ? '' : r.error, /--bogus/);
});

test('usage lists every flag and key', () => {
	for (const text of [
		'--once',
		'--json',
		'--all',
		'--help',
		'--version',
		'Enter',
		'PgUp',
		'Ctrl+C',
	]) {
		assert.ok(USAGE.includes(text), text);
	}
});
