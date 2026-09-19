import assert from 'node:assert/strict';
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import type { Fs } from '../../../src/helpers/types.js';
import { AllYourAgents } from '../../../src/index.js';
import { ohMyPi } from '../../../src/providers/oh-my-pi/index.js';
import { sleep, waitFor } from '../../util/wait.js';
import {
	A,
	appendTranscript,
	assistant,
	B,
	C,
	fakeOmpProcesses,
	header,
	launch,
	lines,
	presencePath,
	sessionPath,
	slot,
	user,
	withHome,
	writeBreadcrumb,
	writePresence,
	writeTranscript,
} from './home.js';

type Procs = ReturnType<typeof fakeOmpProcesses>;

function observe(home: string, procs: Procs, opts: { fs?: Fs; processes?: unknown } = {}) {
	const aya = AllYourAgents({
		providers: [ohMyPi({ home })],
		processes: (opts.processes ?? procs) as Procs,
		fs: opts.fs,
		debounce: { quietMs: 10 },
	});
	const events: string[] = [];
	aya.on('session:create', (s, meta) => events.push(`create:${s.id}:${meta.catchUp}`));
	aya.on('session:open', (s, meta) => events.push(`open:${s.id}:${meta.catchUp}`));
	aya.on('session:close', (s) => events.push(`close:${s.id}`));
	const cwds = new Map<string, string | undefined>();
	aya.on('session:create', (s) => cwds.set(s.id, s.cwd));
	aya.on('session:open', (s) => cwds.set(s.id, s.cwd));
	aya.on('session:update', (s) => {
		if (cwds.get(s.id) === s.cwd) return;
		cwds.set(s.id, s.cwd);
		events.push(`update:${s.id}:${s.cwd}`);
	});
	aya.on('error', (e) =>
		events.push(`error:${String(e.source === 'provider' ? e.error : e.event)}`),
	);
	const live = (id: string) => aya.running().find((s) => s.id === id);
	return { aya, events, live };
}

test('launch with a fresh breadcrumb: create with pid, cwd and id before any transcript', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		const path = await launch(home, procs, {
			id: A,
			pid: 18510,
			terminal: 'ttys024',
			fresh: true,
			cwd: '/tmp/proj',
		});
		await waitFor(() => live(A));
		assert.deepEqual(events, [`create:${A}:false`]);
		const session = live(A);
		assert.equal(session?.pid, 18510);
		assert.equal(session?.cwd, '/tmp/proj');
		assert.equal(session?.kind, 'interactive');
		assert.equal(session?.status, 'idle');
		// The transcript materialises mid-turn, and the breadcrumb loses `fresh`: still one session.
		await writeTranscript(path, [
			slot(),
			header(A, { cwd: '/tmp/proj' }),
			user('hello'),
			assistant('stop'),
		]);
		await writeBreadcrumb(home, 'ttys024', path, { cwd: '/tmp/proj' });
		await waitFor(() => live(A)?.activity.lastTurn === 'completed');
		assert.deepEqual(events, [`create:${A}:false`]);
		assert.equal(live(A)?.title, 'hello');
		await aya.stop();
	});
});

test('already running at start: open during catch-up; resumed transcript is an open', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		await launch(home, procs, { id: A, pid: 7, terminal: 'ttys001', records: [user('hi')] });
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		assert.deepEqual(events, [`open:${A}:true`]);
		assert.equal(live(A)?.status, 'running');
		await aya.stop();
	});
});

test('either half of the registry may arrive first', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, live } = observe(home, procs);
		await aya.start();
		// Presence first.
		procs.set(21, 'ttys021');
		await writePresence(home, 21);
		await sleep(80);
		assert.equal(live(A), undefined);
		await writeBreadcrumb(home, 'ttys021', sessionPath(home, A), { fresh: true });
		await waitFor(() => live(A));
		// Breadcrumb first.
		procs.set(22, 'pts/3');
		await writeBreadcrumb(home, 'pts-3', sessionPath(home, B), { fresh: true });
		await sleep(80);
		assert.equal(live(B), undefined);
		await writePresence(home, 22, { hash: 'ffffffffffffffff' });
		await waitFor(() => live(B));
		assert.equal(live(B)?.pid, 22);
		await aya.stop();
	});
});

test('nothing is bound from a breadcrumb nobody alive owns', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const path = sessionPath(home, A);
		await writeTranscript(path, [slot(), header(A)]);
		// Old breadcrumb, no process at all.
		await writeBreadcrumb(home, 'ttys009', path);
		// A live process on the terminal, but the breadcrumb predates it: another mode of omp.
		const old = await writeBreadcrumb(home, 'ttys010', sessionPath(home, B), { fresh: true });
		const hourAgo = new Date(Date.now() - 3600_000);
		await utimes(old, hourAgo, hourAgo);
		procs.set(30, 'ttys010', Date.now() - 1000);
		await writePresence(home, 30);
		// Headless: presence, no terminal, no breadcrumb.
		procs.set(31, undefined);
		await writePresence(home, 31, { hash: 'eeeeeeeeeeeeeeee' });
		// A multiplexer id is not a terminal we can join on.
		procs.set(32, 'ttys032');
		await writePresence(home, 32, { hash: 'dddddddddddddddd' });
		await writeBreadcrumb(home, 'tmux-%3', sessionPath(home, C), { fresh: true });
		const { aya, events } = observe(home, procs);
		await aya.start();
		await sleep(80);
		assert.deepEqual(events, []);
		assert.ok(
			(await aya.sessions()).some((s) => s.id === A),
			'history is still served',
		);
		await aya.stop();
	});
});

test('corrupt registry files and a header naming another id bind nothing, and watching goes on', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		procs.set(40, 'ttys040');
		await writePresence(home, 40, { body: '{not json' });
		await writeBreadcrumb(home, 'ttys040', sessionPath(home, A), { fresh: true });
		procs.set(41, 'ttys041');
		await writePresence(home, 41, { hash: 'cccccccccccccccc' });
		await writeBreadcrumb(home, 'ttys041', '', { body: '/tmp/app\n' });
		procs.set(42, 'ttys042');
		const wrong = sessionPath(home, B);
		await writeTranscript(wrong, [slot(), header(C)]);
		await writePresence(home, 42, { hash: 'bbbbbbbbbbbbbbbb' });
		await writeBreadcrumb(home, 'ttys042', wrong);
		await sleep(120);
		assert.deepEqual(events, []);
		// Rewritten properly, the first one binds.
		await writePresence(home, 40);
		await waitFor(() => live(A));
		await aya.stop();
	});
});

test('two processes on one terminal: the newer one owns the breadcrumb', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const now = Date.now();
		procs.set(50, 'ttys050', now - 60_000);
		procs.set(51, 'ttys050', now - 2000);
		await writePresence(home, 50);
		await writePresence(home, 51);
		await writeBreadcrumb(home, 'ttys050', sessionPath(home, A), { fresh: true });
		const { aya, live } = observe(home, procs);
		await aya.start();
		assert.equal(live(A)?.pid, 51);
		await aya.stop();
	});
});

test('without a tty probe there are no live sessions, and history still lists', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		await launch(home, procs, { id: A, pid: 60, terminal: 'ttys060', records: [user('hi')] });
		const { tty: _tty, ...noTty } = procs;
		const { aya, events } = observe(home, procs, { processes: noTty });
		await aya.start();
		await sleep(60);
		assert.deepEqual(events, []);
		assert.ok((await aya.sessions()).some((s) => s.id === A));
		await aya.stop();
	});
});

test('clean exit closes once; a kill closes from the exit event and the leftovers bind nothing', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		await launch(home, procs, { id: A, pid: 70, terminal: 'ttys070', records: [user('hi')] });
		await launch(home, procs, { id: B, pid: 71, terminal: 'ttys071', records: [] });
		await waitFor(() => live(A) && live(B));
		await rm(presencePath(home, 70));
		await waitFor(() => events.includes(`close:${A}`));
		procs.fire(71);
		await waitFor(() => events.includes(`close:${B}`));
		// The killed process left its presence file and breadcrumb. Touching them changes nothing.
		await writeBreadcrumb(home, 'ttys071', sessionPath(home, B));
		await writePresence(home, 71);
		await sleep(100);
		assert.equal(events.filter((e) => e.startsWith('close:')).length, 2);
		assert.equal(aya.running().length, 0);
		const closed = await aya.get(A);
		assert.equal(closed?.activity.lastTurn, 'interrupted');
		await aya.stop();
	});
});

test('no process events: a death is found on the next registry event, or by reconcile', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		procs.unsupported();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		await launch(home, procs, { id: A, pid: 80, terminal: 'ttys080', records: [] });
		await launch(home, procs, { id: B, pid: 81, terminal: 'ttys081', records: [] });
		await waitFor(() => live(A) && live(B));
		procs.kill(80);
		await sleep(80);
		assert.ok(live(A), 'nothing re-checks a pid on a clock');
		await launch(home, procs, { id: C, pid: 82, terminal: 'ttys082', fresh: true });
		await waitFor(() => events.includes(`close:${A}`));
		procs.kill(81);
		await aya.reconcile(81);
		assert.ok(events.includes(`close:${B}`));
		await aya.stop();
	});
});

test('session switch in one process: close, then create, nothing carried over', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		await launch(home, procs, {
			id: A,
			pid: 90,
			terminal: 'ttys090',
			records: [user('first prompt')],
		});
		await waitFor(() => live(A)?.status === 'running');
		await writeBreadcrumb(home, 'ttys090', sessionPath(home, B), { fresh: true });
		await waitFor(() => live(B));
		assert.deepEqual(
			events.filter((e) => !e.startsWith('update')),
			[`create:${A}:false`, `close:${A}`, `create:${B}:false`].map((e) =>
				e.startsWith(`create:${A}`) ? `open:${A}:false` : e,
			),
		);
		assert.equal(live(B)?.pid, 90);
		assert.equal(live(B)?.status, 'idle');
		assert.equal(live(B)?.title, undefined);
		// `/resume` back to the existing session is an open.
		await writeBreadcrumb(home, 'ttys090', sessionPath(home, A));
		await waitFor(() => events.at(-1) === `open:${A}:false`);
		await aya.stop();
	});
});

test('relocation: same id at a new path keeps the session, reports the cwd, tails the new file', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		const from = await launch(home, procs, {
			id: A,
			pid: 100,
			terminal: 'ttys100',
			records: [user('hi'), assistant('stop')],
		});
		await waitFor(() => live(A)?.activity.lastTurn === 'completed');
		const to = sessionPath(home, A, '/tmp/moved');
		await writeTranscript(to, [
			slot(),
			header(A, { cwd: '/tmp/moved' }),
			user('hi'),
			assistant('stop'),
		]);
		await rm(from);
		await writeBreadcrumb(home, 'ttys100', to, { cwd: '/tmp/moved' });
		await waitFor(() => events.includes(`update:${A}:/tmp/moved`));
		await appendTranscript(to, [user('again')]);
		await waitFor(() => live(A)?.status === 'running');
		assert.equal(
			events.some((e) => e.startsWith('close')),
			false,
		);
		await aya.stop();
	});
});

test('replaced by a rename: no close, and records appended to the new file are handled once', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		let turns = 0;
		aya.on('session:activity', (s) => {
			if (s.activity.lastTurn === 'completed') turns++;
		});
		await aya.start();
		const path = await launch(home, procs, {
			id: A,
			pid: 110,
			terminal: 'ttys110',
			records: [user('one'), assistant('stop')],
		});
		await waitFor(() => live(A)?.activity.lastTurn === 'completed');
		const before = turns;
		const tmp = `${path}.tmp`;
		await writeFile(tmp, lines([slot('T'), header(A), user('one'), assistant('stop')]));
		await rename(tmp, path);
		await sleep(120);
		await appendTranscript(path, [user('two')]);
		await waitFor(() => live(A)?.status === 'running');
		await appendTranscript(path, [assistant('stop')]);
		await waitFor(() => live(A)?.status === 'idle');
		assert.equal(
			events.some((e) => e.startsWith('close')),
			false,
		);
		assert.ok(turns - before <= 2, `completed turns reported after the replace: ${turns - before}`);
		await aya.stop();
	});
});

test('a sibling session in the same directory does not make us re-read ours', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const reads: string[] = [];
		const inner = createLocalFs();
		const fs: Fs = {
			...inner,
			readRange: (p, s, e) => {
				reads.push(p);
				return inner.readRange(p, s, e);
			},
			readFile: (p, o) => {
				reads.push(p);
				return inner.readFile(p, o);
			},
		};
		// Things omp keeps beside what we read, which are not ours to open.
		await mkdir(join(home, 'agent'), { recursive: true });
		await mkdir(join(home, 'logs'), { recursive: true });
		await writeFile(join(home, 'agent', 'agent.db'), 'secret');
		await writeFile(join(home, 'agent', 'models.db'), 'x');
		await writeFile(join(home, 'logs', 'omp.2026-01-01.1.log'), '{}');
		const { aya, live } = observe(home, procs, { fs });
		await aya.start();
		const mine = await launch(home, procs, {
			id: A,
			pid: 120,
			terminal: 'ttys120',
			records: [user('hi')],
		});
		await waitFor(() => live(A)?.status === 'running');
		await writeFile(`${mine.slice(0, -6)}.lock`, '120:0');
		reads.length = 0;
		const sibling = sessionPath(home, B);
		await writeTranscript(sibling, [slot(), header(B), user('other')]);
		await appendTranscript(sibling, [assistant('stop')]);
		await sleep(120);
		// A late breadcrumb notification may re-read the breadcrumb; no transcript is read.
		assert.deepEqual(
			reads.filter((p) => p.endsWith('.jsonl')),
			[],
		);
		await aya.stop();
		await aya.sessions();
		assert.equal(
			reads.some((p) => /agent\.db|models\.db|\/logs\/|\.lock/.test(p)),
			false,
		);
	});
});

test('profiles: a session under one, a profile created later, and one id in two roots once', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const work = join(home, 'profiles', 'work');
		procs.set(130, 'ttys130');
		const path = sessionPath(home, A, '/tmp/app', work);
		await writeTranscript(path, [slot(), header(A)]);
		await writePresence(home, 130, { root: work });
		await writeBreadcrumb(home, 'ttys130', path, { root: work });
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		assert.deepEqual(events, [`open:${A}:true`]);

		const later = join(home, 'profiles', 'later');
		procs.set(131, 'ttys131');
		await writePresence(home, 131, { root: later });
		await writeBreadcrumb(home, 'ttys131', sessionPath(home, B, '/tmp/app', later), {
			root: later,
			fresh: true,
		});
		await waitFor(() => live(B));

		// The same session id named from the default root as well: still one session.
		procs.set(132, 'ttys132');
		await writePresence(home, 132);
		await writeBreadcrumb(home, 'ttys132', path);
		await sleep(100);
		assert.equal(events.filter((e) => e.includes(A)).length, 1);
		await writeTranscript(sessionPath(home, A), [slot(), header(A)]);
		assert.equal((await aya.sessions()).filter((s) => s.id === A).length, 1);
		await aya.stop();
	});
});

test('a deleted profile closes its sessions and is watched no more', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const work = join(home, 'profiles', 'work');
		procs.set(135, 'ttys135');
		const path = sessionPath(home, A, '/tmp/app', work);
		await writeTranscript(path, [slot(), header(A)]);
		await writePresence(home, 135, { root: work });
		await writeBreadcrumb(home, 'ttys135', path, { root: work });
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		assert.ok(live(A));
		await rm(work, { recursive: true, force: true });
		await waitFor(() => events.includes(`close:${A}`));
		assert.equal(live(A), undefined);
		assert.deepEqual(
			events.filter((e) => e.startsWith('error')),
			[],
		);
		await aya.stop();
	});
});

test('a custom session file: bound from a relative breadcrumb by its header, and listed', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const cwd = join(home, 'proj');
		const path = join(cwd, 'notes', 'work');
		await writeTranscript(path, [slot(), header(A, { cwd }), user('keep notes')]);
		// omp records where the file is, since its sessions directory does not hold it.
		await mkdir(join(home, 'agent', 'custom-session-files'), { recursive: true });
		await writeFile(join(home, 'agent', 'custom-session-files', 'abc123'), path);
		procs.set(140, 'ttys140');
		await writePresence(home, 140);
		await writeBreadcrumb(home, 'ttys140', 'notes/work', { cwd });
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		assert.deepEqual(events, [`open:${A}:true`]);
		assert.equal(live(A)?.cwd, cwd);
		await appendTranscript(path, [assistant('stop')]);
		await waitFor(() => live(A)?.activity.lastTurn === 'completed');
		procs.fire(140);
		await waitFor(() => events.includes(`close:${A}`));
		const listed = await aya.sessions();
		assert.deepEqual(
			listed.filter((s) => s.id === A).map((s) => s.title),
			['keep notes'],
		);
		assert.ok(await aya.get(A));
		await aya.stop();
	});
});

test('ordering: exit while the backlog is read, and stop while binding, leave nothing open', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const inner = createLocalFs();
		let watching = 0;
		const open = new Map<string, number>();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let gated = false;
		const fs: Fs = {
			...inner,
			watch: (p) => {
				// Counted only once it is really open: watching a missing path throws.
				const handle = inner.watch(p);
				watching++;
				open.set(p, (open.get(p) ?? 0) + 1);
				return {
					close: () => {
						watching--;
						open.set(p, (open.get(p) ?? 0) - 1);
						handle.close();
					},
					[Symbol.asyncIterator]: () => handle[Symbol.asyncIterator](),
				};
			},
			readRange: async (p, s, e) => {
				if (gated && p.endsWith(`${A}.jsonl`) && s === 0 && (e ?? 0) > 70_000) await gate;
				return inner.readRange(p, s, e);
			},
		};
		const { aya, events } = observe(home, procs, { fs });
		await aya.start();
		const idle = watching;
		gated = true;
		await launch(home, procs, {
			id: A,
			pid: 140,
			terminal: 'ttys140',
			records: [user('x'.repeat(80_000))],
		});
		await waitFor(() => events.some((e) => e.startsWith(`open:${A}`)));
		procs.fire(140);
		release?.();
		await waitFor(() => events.includes(`close:${A}`));
		await sleep(120);
		const left = [...open].filter(([, n]) => n > 0).map(([p]) => p.replace(home, '~'));
		assert.equal(
			left.some((p) => p.includes('sessions/')),
			false,
			`nothing of the session stays watched: ${left.join(' ')}`,
		);
		void idle;

		const stopped = observe(home, procs, { fs });
		procs.set(141, 'ttys141');
		await writePresence(home, 141);
		await writeBreadcrumb(home, 'ttys141', sessionPath(home, B), { fresh: true });
		const starting = stopped.aya.start();
		await stopped.aya.stop();
		await starting.catch(() => {});
		await aya.stop();
		await sleep(80);
		const still = [...open]
			.filter(([, n]) => n > 0)
			.map(([p, n]) => `${p.replace(home, '~')}x${n}`);
		assert.equal(watching, 0, still.join(' '));
	});
});
