import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import type { Provider } from '../../../src/provider.js';
import { grokBuild } from '../../../src/providers/grok-build/index.js';
import type { AgentsError, Session } from '../../../src/types.js';
import { spyFs } from '../../util/spy-fs.js';
import { sleep, waitFor } from '../../util/wait.js';
import { entry, fakeProcesses, makeSession, user, writeIndex } from './home.js';

const A = '01a0b474-0a8c-7002-b1fd-ff90b332cdc3';
const line = (rec: unknown) => `${JSON.stringify(rec)}\n`;

async function live(
	files: Parameters<typeof makeSession>[3],
	fn: (ctx: {
		home: string;
		dir: string;
		aya: ReturnType<typeof AllYourAgents>;
		activity: Session[];
		updates: Session[];
		errors: unknown[];
	}) => Promise<void>,
): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	try {
		const start = Date.now() - 1000;
		const procs = fakeProcesses(start);
		procs.set(8, true, start);
		const dir = await makeSession(home, '/app', A, files);
		await writeIndex(home, [entry(A, 8, '/app')]);
		const aya = AllYourAgents({
			providers: [grokBuild({ home })],
			processes: procs,
			debounce: { quietMs: 10 },
		});
		const activity: Session[] = [];
		const updates: Session[] = [];
		const errors: unknown[] = [];
		aya.on('session:activity', (s) => activity.push(s));
		aya.on('session:update', (s) => updates.push(s));
		aya.on('error', (e) => errors.push(e));
		await aya.start();
		try {
			await fn({ home, dir, aya, activity, updates, errors });
		} finally {
			await aya.stop();
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

const turn = (i: number) => [
	{ type: 'turn_started', ts: new Date(1_000_000 + i * 10).toISOString() },
	{ type: 'phase_changed', phase: 'waiting_for_model' },
	{ type: 'tool_started', tool_name: 'read_file' },
	{ type: 'tool_completed', tool_name: 'read_file', tool_call_id: `c${i}`, outcome: 'success' },
	{ type: 'turn_ended', outcome: 'completed', ts: new Date(1_000_000 + i * 10 + 5).toISOString() },
];

test('replaying forty turns at bind reports activity once', async () => {
	await live(
		{ events: Array.from({ length: 40 }, (_, i) => turn(i)).flat() },
		async ({ aya, activity }) => {
			assert.equal(activity.length, 1);
			assert.equal(aya.running()[0]?.activity.lastTurn, 'completed');
			assert.equal(aya.running()[0]?.status, 'idle');
		},
	);
});

test('bound idle mid-tool: no open tool, the turn was interrupted', async () => {
	await live(
		{
			events: [
				{ type: 'turn_started' },
				{ type: 'turn_ended', outcome: 'completed' },
				{ type: 'tool_started', tool_name: 'run_terminal_command' },
			],
		},
		async ({ aya }) => {
			const s = aya.running()[0];
			assert.equal(s?.activity.tool, undefined);
			assert.equal(s?.activity.lastTurn, 'interrupted');
		},
	);
});

test('MCP setup is not a turn', async () => {
	await live(
		{ events: [{ type: 'mcp_server_starting' }, { type: 'mcp_init_completed' }] },
		async ({ aya }) => {
			const s = aya.running()[0];
			assert.equal(s?.activity.lastTurn, undefined);
			assert.equal(s?.status, 'idle');
		},
	);
});

test('a failed turn without chat error has no message; with one it stands until the next turn', async () => {
	await live({ events: [], chat: [user('go', 0)] }, async ({ dir, aya }) => {
		const events = join(dir, 'events.jsonl');
		await appendFile(
			events,
			line({ type: 'turn_started' }) + line({ type: 'turn_ended', outcome: 'error' }),
		);
		await waitFor(() => aya.running()[0]?.activity.lastTurn === 'failed');
		assert.equal(aya.running()[0]?.activity.error, undefined);
		await appendFile(
			join(dir, 'chat_history.jsonl'),
			line(user('again', 1)) + line({ type: 'assistant', error: 'rate limited' }),
		);
		await sleep(40);
		await appendFile(
			events,
			line({ type: 'turn_started' }) + line({ type: 'turn_ended', outcome: 'error' }),
		);
		await waitFor(() => aya.running()[0]?.activity.error === 'rate limited');
		await appendFile(
			events,
			line({ type: 'turn_started' }) + line({ type: 'phase_changed', phase: 'streaming_text' }),
		);
		await waitFor(() => aya.running()[0]?.status === 'running');
		assert.equal(aya.running()[0]?.activity.error, undefined);
	});
});

test('tools: started by name, finished by name, a failing tool keeps the turn open', async () => {
	await live({ events: [] }, async ({ dir, aya }) => {
		const events = join(dir, 'events.jsonl');
		await appendFile(
			events,
			line({ type: 'turn_started' }) + line({ type: 'tool_started', tool_name: 'grep' }),
		);
		await waitFor(() => aya.running()[0]?.activity.tool?.id === 'grep');
		await appendFile(
			events,
			line({ type: 'tool_completed', tool_name: 'grep', tool_call_id: 'c9', outcome: 'error' }),
		);
		await waitFor(() => !aya.running()[0]?.activity.tool);
		assert.equal(aya.running()[0]?.status, 'running');
	});
});

test('a record that cannot be handled is reported and later ones still apply', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	const start = Date.now() - 1000;
	const procs = fakeProcesses(start);
	procs.set(8, true, start);
	const dir = await makeSession(home, '/app', A, { events: [{ type: 'turn_started' }] });
	await writeIndex(home, [entry(A, 8, '/app')]);
	const real = grokBuild({ home });
	// The core never throws from emit. This stands in for any failure inside the handler.
	const failing: Provider = {
		...real,
		watch: (ctx) =>
			real.watch({
				...ctx,
				emit: ((event: string, payload: { id?: string }) => {
					if (event === 'turn' && payload.id === 'bad') throw new Error('cannot handle');
					(ctx.emit as (e: string, p: unknown) => void)(event, payload);
				}) as typeof ctx.emit,
			}),
	};
	const aya = AllYourAgents({ providers: [failing], processes: procs, debounce: { quietMs: 10 } });
	const errors: AgentsError[] = [];
	aya.on('error', (e) => errors.push(e));
	try {
		await aya.start();
		const events = join(dir, 'events.jsonl');
		await appendFile(events, line({ type: 'tool_started', tool_name: 'bad' }));
		await waitFor(() => errors.length === 1);
		await appendFile(events, line({ type: 'tool_started', tool_name: 'edit_file' }));
		await waitFor(() => aya.running()[0]?.activity.tool?.name === 'edit_file');
		const [error] = errors;
		assert.ok(error?.source === 'provider');
		assert.equal(error.provider, 'grok-build');
		assert.equal(errors.length, 1);
	} finally {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test('files present at bind are read once; an append is handled once', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	const start = Date.now() - 1000;
	const procs = fakeProcesses(start);
	procs.set(8, true, start);
	const dir = await makeSession(home, '/app', A, {
		events: Array.from({ length: 20 }, (_, i) => turn(i)).flat(),
		chat: [user('go', 0)],
	});
	await writeIndex(home, [entry(A, 8, '/app')]);
	const fs = spyFs();
	const aya = AllYourAgents({
		providers: [grokBuild({ home })],
		processes: procs,
		fs,
		debounce: { quietMs: 10 },
	});
	const tools: string[] = [];
	aya.on('session:activity', (s) => {
		if (s.activity.tool) tools.push(s.activity.tool.id);
	});
	try {
		await aya.start();
		const events = join(dir, 'events.jsonl');
		const size = (await stat(events)).size;
		const chatSize = (await stat(join(dir, 'chat_history.jsonl'))).size;
		assert.equal(fs.bytesRead.get(events), size);
		assert.equal(fs.bytesRead.get(join(dir, 'chat_history.jsonl')), chatSize);
		const appended =
			line({ type: 'turn_started' }) + line({ type: 'tool_started', tool_name: 'grep' });
		await appendFile(events, appended);
		await waitFor(() => tools.includes('grep'));
		await sleep(40);
		assert.deepEqual(tools, ['grep']);
		assert.equal(fs.bytesRead.get(events), size + appended.length);
	} finally {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test('model at bind, then a mid-session switch', async () => {
	await live(
		{ summary: { current_model_id: 'grok-4.6' }, events: [] },
		async ({ dir, aya, updates }) => {
			assert.equal(aya.running()[0]?.model, 'grok-4.6');
			await appendFile(
				join(dir, 'events.jsonl'),
				line({ type: 'turn_started', model_id: 'grok-5' }),
			);
			await waitFor(() => updates.some((s) => s.model === 'grok-5'));
		},
	);
});

test('titles: prompt when there is no generated title; a manual rename wins', async () => {
	await live({ chat: [user('please fix the flaky test', 0)] }, async ({ dir, aya }) => {
		assert.equal(aya.running()[0]?.title, 'please fix the flaky test');
		await writeFile(
			join(dir, 'summary.json'),
			JSON.stringify({ generated_title: 'Fix flaky test' }),
		);
		await waitFor(() => aya.running()[0]?.title === 'Fix flaky test');
		await writeFile(
			join(dir, 'summary.json'),
			JSON.stringify({ generated_title: 'Mine', title_is_manual: true }),
		);
		await waitFor(() => aya.running()[0]?.title === 'Mine');
	});
});
