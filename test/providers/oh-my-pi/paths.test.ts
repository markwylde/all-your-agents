import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import {
	artifactDir,
	ompHome,
	parseSessionFileName,
	resolveRoot,
	resolveRoots,
} from '../../../src/providers/oh-my-pi/paths.js';
import {
	breadcrumbNameOf,
	isTerminalName,
	parseBreadcrumb,
	parsePresence,
	REGISTRY_MAX_BYTES,
	readPresence,
} from '../../../src/providers/oh-my-pi/registry.js';
import { parseHead, readHead } from '../../../src/providers/oh-my-pi/session-file.js';
import {
	A,
	B,
	header,
	sessionPath,
	slot,
	withHome,
	writePresence,
	writeTranscript,
} from './home.js';

const fs = createLocalFs();

test('home: option, then PI_CONFIG_DIR, then ~/.omp', () => {
	assert.equal(ompHome({ home: '/x', env: { PI_CONFIG_DIR: '.other' } }), '/x');
	assert.equal(ompHome({ env: { PI_CONFIG_DIR: '.omp-test' }, homedir: '/h' }), '/h/.omp-test');
	assert.equal(ompHome({ env: {}, homedir: '/h' }), '/h/.omp');
});

test('root: layout, PI_CODING_AGENT_DIR, and an explicit home ignoring the environment', async () => {
	const plain = await resolveRoot(fs, { env: {}, homedir: '/h' });
	assert.deepEqual(plain, {
		sessions: '/h/.omp/agent/sessions',
		terminalSessions: '/h/.omp/agent/terminal-sessions',
		daemons: '/h/.omp/run/daemons',
		historyDb: '/h/.omp/agent/history.db',
		customSessionFiles: '/h/.omp/agent/custom-session-files',
	});
	const moved = await resolveRoot(fs, { env: { PI_CODING_AGENT_DIR: '/agent' }, homedir: '/h' });
	assert.equal(moved.sessions, '/agent/sessions');
	assert.equal(moved.daemons, '/h/.omp/run/daemons');
	const explicit = await resolveRoot(fs, {
		home: '/fixture',
		env: { PI_CODING_AGENT_DIR: '/agent', XDG_DATA_HOME: '/xdg' },
	});
	assert.equal(explicit.sessions, '/fixture/agent/sessions');
});

test('root: XDG redirects, flattened, only once $XDG/omp exists', async () => {
	await withHome(async (tmp) => {
		const env = { XDG_DATA_HOME: join(tmp, 'data'), XDG_STATE_HOME: join(tmp, 'state') };
		const before = await resolveRoot(fs, { env, homedir: '/h' });
		assert.equal(before.sessions, '/h/.omp/agent/sessions');
		await mkdir(join(tmp, 'data', 'omp'), { recursive: true });
		await mkdir(join(tmp, 'state', 'omp'), { recursive: true });
		const after = await resolveRoot(fs, { env, homedir: '/h' });
		assert.equal(after.sessions, join(tmp, 'data', 'omp', 'sessions'));
		assert.equal(after.historyDb, join(tmp, 'data', 'omp', 'history.db'));
		assert.equal(after.terminalSessions, join(tmp, 'state', 'omp', 'terminal-sessions'));
		assert.equal(after.daemons, join(tmp, 'state', 'omp', 'run', 'daemons'));
		assert.equal(after.customSessionFiles, join(tmp, 'state', 'omp', 'custom-session-files'));
		// A moved agent directory turns XDG off, as omp does.
		const moved = await resolveRoot(fs, {
			env: { ...env, PI_CODING_AGENT_DIR: '/agent' },
			homedir: '/h',
		});
		assert.equal(moved.sessions, '/agent/sessions');
		assert.equal(moved.historyDb, '/agent/history.db');
		assert.equal(moved.terminalSessions, '/agent/terminal-sessions');
		assert.equal(moved.daemons, '/h/.omp/run/daemons');
		// ...unless it names the default one.
		const same = await resolveRoot(fs, {
			env: { ...env, PI_CODING_AGENT_DIR: '/h/.omp/agent' },
			homedir: '/h',
		});
		assert.equal(same.sessions, join(tmp, 'data', 'omp', 'sessions'));
	});
});

test('roots: the default plus each named profile', async () => {
	await withHome(async (home) => {
		await mkdir(join(home, 'profiles', 'work'), { recursive: true });
		await mkdir(join(home, 'profiles', '.hidden'), { recursive: true });
		const roots = await resolveRoots(fs, { home });
		assert.deepEqual(
			roots.map((root) => root.sessions),
			[join(home, 'agent', 'sessions'), join(home, 'profiles', 'work', 'agent', 'sessions')],
		);
	});
});

test('roots: a profile that exists only under XDG is found too, once', async () => {
	await withHome(async (tmp) => {
		const env = { XDG_DATA_HOME: join(tmp, 'data'), XDG_STATE_HOME: join(tmp, 'state') };
		const homedir = join(tmp, 'h');
		await mkdir(join(tmp, 'data', 'omp', 'profiles', 'moved'), { recursive: true });
		await mkdir(join(tmp, 'state', 'omp', 'profiles', 'moved'), { recursive: true });
		await mkdir(join(homedir, '.omp', 'profiles', 'work'), { recursive: true });
		const roots = await resolveRoots(fs, { env, homedir });
		assert.deepEqual(
			roots.map((root) => root.sessions),
			[
				join(tmp, 'data', 'omp', 'sessions'),
				join(tmp, 'data', 'omp', 'profiles', 'moved', 'sessions'),
				join(homedir, '.omp', 'profiles', 'work', 'agent', 'sessions'),
			],
		);
	});
});

test('session file name: id, timestamp, and what is not one', () => {
	const parsed = parseSessionFileName(`2026-09-19T08-31-39-308Z_${A}.jsonl`);
	assert.equal(parsed?.id, A);
	assert.equal(parsed?.startedAt, Date.parse('2026-09-19T08:31:39.308Z'));
	assert.equal(parseSessionFileName(`${A}.jsonl`), undefined);
	assert.equal(parseSessionFileName('2026-09-19T08-31-39-308Z_not-a-uuid.jsonl'), undefined);
	assert.equal(parseSessionFileName(`.2026-09-19T08-31-39-308Z_${A}.jsonl.lock`), undefined);
	assert.equal(artifactDir(`/s/-tmp-/x_${A}.jsonl`), `/s/-tmp-/x_${A}`);
	assert.equal(artifactDir('/p/notes/work'), undefined, 'omp gives a custom name no artifacts');
});

test('presence: pid must be a positive integer; junk and oversize are refused', async () => {
	assert.deepEqual(parsePresence('{"pid":301,"id":"301-x","projectDir":"/p"}'), {
		pid: 301,
		projectDir: '/p',
	});
	assert.equal(parsePresence('{"pid":0}'), undefined);
	assert.equal(parsePresence('{"pid":"301"}'), undefined);
	assert.equal(parsePresence('{'), undefined);
	await withHome(async (home) => {
		const big = await writePresence(home, 9, {
			body: JSON.stringify({ pid: 9, pad: 'x'.repeat(REGISTRY_MAX_BYTES) }),
		});
		assert.equal(await readPresence(fs, big), undefined);
	});
});

test('breadcrumb: cwd, session file, fresh; and what is refused', () => {
	const path = `/h/.omp/agent/sessions/-p-/2026-09-19T08-31-39-308Z_${A}.jsonl`;
	const full = parseBreadcrumb(`/p\n${path}\nfresh\ncwdstat 16777232 110168705\n`);
	assert.equal(full?.cwd, '/p');
	assert.equal(full?.sessionId, A);
	assert.equal(full?.fresh, true);
	assert.equal(parseBreadcrumb(`/p\n${path}\ncwdstat 1 2\n`)?.fresh, false);
	assert.equal(parseBreadcrumb(`/p\n${path}\n`)?.sessionPath, path);
	assert.equal(parseBreadcrumb('/p\n'), undefined);
	assert.equal(parseBreadcrumb('p\nnotes/work\n'), undefined, 'a cwd must be absolute');
	// `--session`: any name, and a path relative to the cwd. The header will say which session.
	const custom = parseBreadcrumb('/p\nnotes/work\n');
	assert.equal(custom?.sessionPath, '/p/notes/work');
	assert.equal(custom?.sessionId, undefined);
});

test('terminal names: tty devices only, and pts/3 is recorded as pts-3', () => {
	for (const name of ['ttys024', 'pts-3', 'tty1']) assert.equal(isTerminalName(name), true, name);
	for (const name of ['zellij-main-4', 'tmux-%3', 'cmux-1', 'kitty-7', 'wezterm-2', 'apple-ABC']) {
		assert.equal(isTerminalName(name), false, name);
	}
	assert.equal(breadcrumbNameOf('pts/3'), 'pts-3');
	assert.equal(breadcrumbNameOf('ttys024'), 'ttys024');
});

test('head: slot title, header, and the id must match the file name', async () => {
	await withHome(async (home) => {
		const path = sessionPath(home, A);
		await writeTranscript(path, [slot('Lighthouse', 'auto'), header(A, { cwd: '/tmp/proj' })]);
		const head = await readHead(fs, path, { requireNameMatch: true });
		assert.equal(head?.id, A);
		assert.equal(head?.cwd, '/tmp/proj');
		assert.equal(head?.title, 'Lighthouse');
		assert.equal(head?.titleSource, 'harness');

		const wrong = sessionPath(home, B);
		await writeTranscript(wrong, [slot(), header(A)]);
		assert.equal(await readHead(fs, wrong, { requireNameMatch: true }), undefined);
		assert.equal((await readHead(fs, wrong))?.id, A);
	});
	assert.equal(parseHead(`${JSON.stringify(slot())}\n`), undefined);
	assert.equal(
		parseHead(`${JSON.stringify(slot('', 'auto'))}\n${JSON.stringify(header(A))}\n`)?.title,
		undefined,
	);
	assert.equal(
		parseHead(`${JSON.stringify(slot('Mine', 'user'))}\n${JSON.stringify(header(A))}\n`)
			?.titleSource,
		'user',
	);
	assert.equal(parseHead(`${JSON.stringify(slot())}\n{"type":"session","id":"${A}"`), undefined);
	// Before the slot existed the header came first.
	assert.equal(parseHead(`${JSON.stringify(header(A))}\n`)?.id, A);
	const huge = header(A, { pad: 'x'.repeat(80 * 1024) });
	await withHome(async (home) => {
		const path = sessionPath(home, A);
		await writeTranscript(path, [slot(), huge]);
		assert.equal(await readHead(fs, path), undefined);
	});
});
