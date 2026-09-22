import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import type { Fs } from '../../../src/helpers/types.js';
import { AllYourAgents } from '../../../src/index.js';
import { ohMyPi } from '../../../src/providers/oh-my-pi/index.js';
import { sleep, waitFor } from '../../util/wait.js';
import {
	A,
	afterBind,
	appendTranscript,
	artifacts,
	assistant,
	backgrounded,
	entry,
	fakeOmpProcesses,
	header,
	launch,
	marker,
	presencePath,
	sessionExit,
	sessionPath,
	slot,
	toolCall,
	toolResult,
	user,
	withHome,
	writeTranscript,
} from './home.js';

type Procs = ReturnType<typeof fakeOmpProcesses>;

function observe(home: string, procs: Procs, fs?: Fs) {
	const aya = AllYourAgents({
		providers: [ohMyPi({ home })],
		processes: procs,
		fs,
		debounce: { quietMs: 10 },
	});
	const events: string[] = [];
	aya.on('subagent:start', (s) =>
		events.push(`start:${s.id}:${s.type}:${s.parentId ?? ''}:${s.background ? 'bg' : 'fg'}`),
	);
	aya.on('subagent:end', (s) => events.push(`end:${s.id}:${s.status}`));
	const live = (id: string) => aya.running().find((s) => s.id === id);
	return { aya, events, live };
}

const childId = (n: number) => `00000000-0000-4000-9000-00000000000${n}`;

function child(parentSession: string, n: number, agent = 'sonic', at?: number) {
	return [
		slot(),
		header(childId(n), { parentSession }, at),
		entry('model_change', { model: 'xai-oauth/grok-4.6' }),
		entry('session_init', { agent, task: 'Compute it', tools: ['read'] }),
		user('Compute it'),
	];
}

const yielded = (name: string, status = 'success') => [
	assistant('toolUse', [toolCall(`y-${name}`, 'yield')]),
	marker(`y-${name}`, 'yield'),
	toolResult(`y-${name}`, 'yield', { data: { result: 1 }, status }),
];

test('three parallel subagents start with their type and end completed; other files are ignored', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		const path = await launch(home, procs, {
			id: A,
			pid: 300,
			terminal: 'ttys300',
			records: [user('spawn three')],
		});
		await waitFor(() => live(A));
		const dir = artifacts(path);
		const names = ['PowTwoTen', 'MulSeventeenTwentyThree', 'DivOneFortyFour'];
		for (const [i, name] of names.entries())
			await writeTranscript(join(dir, `${name}.jsonl`), child(path, i + 1, 'sonic', afterBind()));
		await writeFile(join(dir, '0.bash.log'), 'log');
		await writeFile(join(dir, 'PowTwoTen.md'), 'result');
		await writeFile(join(dir, 'PowTwoTen.json'), '{}');
		await waitFor(() => events.filter((e) => e.startsWith('start:')).length === 3);
		assert.deepEqual(events.slice().sort(), names.map((n) => `start:${n}:sonic::fg`).sort());
		assert.equal(live(A)?.activity.openSubagents, 3);
		for (const name of names) await appendTranscript(join(dir, `${name}.jsonl`), yielded(name));
		await waitFor(() => events.filter((e) => e.startsWith('end:')).length === 3);
		assert.ok(names.every((n) => events.includes(`end:${n}:completed`)));
		// A root session's state is its own: three children finishing did not end its turn.
		assert.equal(live(A)?.status, 'running');
		// Exit appends `session_exit` to every child too. They already ended.
		for (const name of names) await appendTranscript(join(dir, `${name}.jsonl`), [sessionExit()]);
		await sleep(100);
		assert.equal(events.length, 6);
		await aya.stop();
	});
});

test('background: a child outlives the turn; nested: its parent is the subagent that spawned it', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		const path = await launch(home, procs, {
			id: A,
			pid: 310,
			terminal: 'ttys310',
			records: [user('go')],
		});
		await waitFor(() => live(A));
		const dir = artifacts(path);
		const outer = join(dir, 'ScoutCode.jsonl');
		await writeTranscript(outer, child(path, 1, 'scout', afterBind()));
		await waitFor(() => events.includes('start:ScoutCode:scout::fg'));
		await writeTranscript(
			join(dir, 'ScoutCode', 'ScoutCode.Inner.jsonl'),
			child(outer, 2, 'sonic'),
		);
		await waitFor(() => events.includes('start:ScoutCode.Inner:sonic:ScoutCode:fg'));

		await appendTranscript(path, [assistant('stop')]);
		await waitFor(() => live(A)?.status === 'idle');
		assert.equal(live(A)?.activity.openSubagents, 2, 'idle does not cancel them');
		const open = await live(A)?.subagents();
		assert.ok(open?.length === 2 && open.every((s) => s.status === 'running'));

		await appendTranscript(outer, yielded('ScoutCode', 'error'));
		await waitFor(() => events.includes('end:ScoutCode:failed'));
		// A later record on an ended child does not bring it back.
		await appendTranscript(outer, [user('more input'), assistant('stop')]);
		await sleep(100);
		assert.equal(events.filter((e) => /^(start|end):ScoutCode:/.test(e)).length, 2);

		// The process quits with the inner one still open: cancelled, once.
		const { rm } = await import('node:fs/promises');
		await rm(presencePath(home, 310));
		await waitFor(() => events.includes('end:ScoutCode.Inner:cancelled'));
		assert.equal(events.filter((e) => e.startsWith('end:ScoutCode.Inner')).length, 1);
		await aya.stop();
	});
});

test('background: a child outlives a turn that ends waiting on a shell job, as it does an idle one', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		const path = await launch(home, procs, {
			id: A,
			pid: 312,
			terminal: 'ttys312',
			records: [user('go')],
		});
		await waitFor(() => live(A));
		const outer = join(artifacts(path), 'ScoutCode.jsonl');
		await writeTranscript(outer, child(path, 1, 'scout', afterBind()));
		await waitFor(() => events.includes('start:ScoutCode:scout::fg'));

		await appendTranscript(path, [
			assistant('toolUse', [toolCall('call-1', 'bash')]),
			backgrounded('call-1', 'bg_1'),
			assistant('stop'),
		]);
		await waitFor(() => live(A)?.status === 'waiting');
		assert.equal(live(A)?.waitingFor, 'shell');
		assert.equal(live(A)?.activity.openSubagents, 1, 'the turn end does not cancel it');
		const open = await live(A)?.subagents();
		assert.ok(open?.length === 1 && open[0]?.status === 'running');

		// It still ends on its own word, and the session goes on waiting for the job.
		await appendTranscript(outer, yielded('ScoutCode'));
		await waitFor(() => events.includes('end:ScoutCode:completed'));
		assert.equal(live(A)?.status, 'waiting');
		assert.deepEqual(events, ['start:ScoutCode:scout::fg', 'end:ScoutCode:completed']);
		await aya.stop();
	});
});

test('an agent the task result spawned asynchronously starts as background', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		const path = await launch(home, procs, {
			id: A,
			pid: 315,
			terminal: 'ttys315',
			records: [user('go')],
		});
		await waitFor(() => live(A));
		await appendTranscript(path, [
			assistant('toolUse', [toolCall('c1', 'task')]),
			marker('c1', 'task'),
			toolResult('c1', 'task', {
				progress: [{ id: 'PowTwoTen', agent: 'sonic', status: 'pending' }],
				async: { state: 'running', jobId: 'PowTwoTen', type: 'task' },
			}),
		]);
		await waitFor(() => live(A)?.activity.tool === undefined && live(A)?.status === 'running');
		await sleep(50);
		await writeTranscript(join(artifacts(path), 'PowTwoTen.jsonl'), child(path, 1));
		await waitFor(() => events.includes('start:PowTwoTen:sonic::bg'));
		await aya.stop();
	});
});

test('catch-up: finished children are reported ended without a start; a running one is seeded', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const path = await launch(home, procs, {
			id: A,
			pid: 320,
			terminal: 'ttys320',
			records: [user('go')],
		});
		const dir = artifacts(path);
		await writeTranscript(join(dir, 'Done.jsonl'), [...child(path, 1), ...yielded('Done')]);
		await writeTranscript(join(dir, 'Broke.jsonl'), [
			...child(path, 2),
			assistant('error', [], { errorMessage: 'x' }),
		]);
		await writeTranscript(join(dir, 'Still.jsonl'), child(path, 3, 'scout'));
		const { aya, events, live } = observe(home, procs);
		await aya.start();
		assert.equal(events.length, 0, 'nothing starts now');
		const subs = await live(A)?.subagents();
		assert.deepEqual(subs?.map((s) => `${s.id}:${s.status}:${s.type}`).sort(), [
			'Broke:failed:sonic',
			'Done:completed:sonic',
			'Still:running:scout',
		]);
		assert.equal(live(A)?.activity.openSubagents, 1);
		await appendTranscript(join(dir, 'Still.jsonl'), yielded('Still'));
		await waitFor(() => events.includes('end:Still:completed'));
		await aya.stop();

		// From history alone, with nothing live: every child has a final status.
		const later = AllYourAgents({ providers: [ohMyPi({ home })], processes: fakeOmpProcesses() });
		const closed = await later.get(A);
		const final = await closed?.subagents();
		assert.deepEqual(final?.map((s) => `${s.id}:${s.status}`).sort(), [
			'Broke:failed',
			'Done:completed',
			'Still:completed',
		]);
	});
});

test('a child spawned while the session is still binding starts; one there before is seeded', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const path = sessionPath(home, A);
		const dir = artifacts(path);
		await writeTranscript(path, [slot(), header(A), user('go')]);
		await writeTranscript(join(dir, 'Before.jsonl'), child(path, 1));
		await sleep(5);
		// Holds the bind in its first read of the transcript, as a slow disk would.
		const inner = createLocalFs();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reading: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			reading = resolve;
		});
		const fs: Fs = {
			...inner,
			readRange: async (p, start, end) => {
				if (p === path) {
					reading?.();
					await gate;
				}
				return inner.readRange(p, start, end);
			},
		};
		const { aya, events } = observe(home, procs, fs);
		await aya.start();
		await launch(home, procs, { id: A, pid: 330, terminal: 'ttys330', records: [user('go')] });
		await held;
		await sleep(5);
		await writeTranscript(join(dir, 'During.jsonl'), child(path, 2));
		release?.();
		await waitFor(() => events.includes('start:During:sonic::fg'));
		assert.equal(
			events.some((e) => e.startsWith('start:Before')),
			false,
		);
		await aya.stop();
	});
});

test('from history: background from the task result, and a parent report ends a child', async () => {
	await withHome(async (home) => {
		const path = sessionPath(home, A);
		const dir = artifacts(path);
		await writeTranscript(path, [
			slot(),
			header(A),
			user('go'),
			assistant('toolUse', [toolCall('c1', 'task')]),
			marker('c1', 'task'),
			toolResult('c1', 'task', {
				progress: [{ id: 'Bg', agent: 'sonic', status: 'pending' }],
				async: { state: 'running', jobId: 'Bg', type: 'task' },
			}),
			assistant('toolUse', [toolCall('c3', 'task')]),
			marker('c3', 'task'),
			toolResult('c3', 'task', { progress: [{ id: 'Quiet', agent: 'sonic', status: 'pending' }] }),
			// The parent's word on an agent whose own transcript never said how it ended.
			toolResult('c2', 'hub', { jobs: [{ id: 'Quiet', status: 'completed' }] }),
		]);
		await writeTranscript(join(dir, 'Bg.jsonl'), [...child(path, 1), ...yielded('Bg')]);
		await writeTranscript(join(dir, 'Quiet.jsonl'), [...child(path, 2), assistant('stop')]);
		await writeTranscript(join(dir, 'Cut.jsonl'), child(path, 3));
		const aya = AllYourAgents({ providers: [ohMyPi({ home })], processes: fakeOmpProcesses() });
		const subs = await (await aya.get(A))?.subagents();
		assert.deepEqual(subs?.map((s) => `${s.id}:${s.status}:${s.background}`).sort(), [
			'Bg:completed:true',
			'Cut:cancelled:false',
			'Quiet:completed:false',
		]);
	});
});

test('a subagent transcript replays on its own and is never a session', async () => {
	await withHome(async (home) => {
		const procs = fakeOmpProcesses();
		const path = await launch(home, procs, {
			id: A,
			pid: 330,
			terminal: 'ttys330',
			records: [user('go')],
		});
		await writeTranscript(join(artifacts(path), 'Done.jsonl'), [
			...child(path, 1),
			...yielded('Done'),
		]);
		const reads: string[] = [];
		const inner = createLocalFs();
		const { aya, live } = observe(home, procs, {
			...inner,
			readRange: (p, s, e) => {
				reads.push(p);
				return inner.readRange(p, s, e);
			},
		});
		await aya.start();
		const [sub] = (await live(A)?.subagents()) ?? [];
		assert.ok(sub);
		const turns = [];
		for await (const turn of sub.transcript()) turns.push(turn);
		assert.equal(turns.length, 1);
		assert.deepEqual(
			turns[0]?.events.map((e) => e.kind),
			['user', 'tool', 'tool-result'],
		);
		const listed = await aya.sessions();
		assert.deepEqual(
			listed.map((s) => s.id),
			[A],
		);
		assert.equal(live(A)?.activity.tool, undefined, "the child's tool is not the root's");
		await aya.stop();
	});
});
