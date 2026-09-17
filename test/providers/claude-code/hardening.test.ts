import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import type { Provider } from '../../../src/provider.js';
import { claudeCode } from '../../../src/providers/claude-code/index.js';
import { encodeProjectDir } from '../../../src/providers/claude-code/paths.js';
import type { AgentsError, Session } from '../../../src/types.js';
import { spyFs } from '../../util/spy-fs.js';
import { sleep, waitFor } from '../../util/wait.js';
import { fakeProcesses, journal, sessionFile } from './home.js';

const ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CWD = '/tmp/app';

const user = (text: string) => ({
	type: 'user',
	sessionId: ID,
	timestamp: new Date().toISOString(),
	message: { role: 'user', content: text },
});

const assistant = (model: string, content: unknown[], stopReason?: string) => ({
	type: 'assistant',
	sessionId: ID,
	timestamp: new Date().toISOString(),
	message: { role: 'assistant', model, content, stop_reason: stopReason },
});

const reply = (model: string, text = 'ok') =>
	assistant(model, [{ type: 'text', text }], 'end_turn');

const toolUse = (id: string, name = 'Bash') =>
	assistant('claude-opus-5', [{ type: 'tool_use', id, name, input: {} }]);

const journalPath = (home: string) => join(home, 'projects', encodeProjectDir(CWD), `${ID}.jsonl`);

async function liveHome(records: unknown[]) {
	const home = await mkdtemp(join(tmpdir(), 'aya-cc-'));
	const start = Date.now() - 500;
	const procs = fakeProcesses(start);
	procs.set(1, true, start);
	await journal(home, CWD, ID, records);
	const bindSession = () => sessionFile(home, 1, { sessionId: ID, cwd: CWD }, start);
	return { home, procs, bindSession };
}

const append = (home: string, record: unknown) =>
	appendFile(journalPath(home), `${JSON.stringify(record)}\n`);

test('model is known at bind, follows a switch, and ignores synthetic records', async () => {
	const { home, procs, bindSession } = await liveHome([
		user('first prompt'),
		reply('claude-sonnet-5'),
		user('again'),
		reply('claude-opus-5'),
	]);
	await bindSession();
	const aya = AllYourAgents({
		providers: [claudeCode({ home })],
		processes: procs,
		debounce: { quietMs: 10 },
	});
	const models: (string | undefined)[] = [];
	aya.on('session:update', (s) => models.push(s.model));
	try {
		await aya.start();
		const atReady = aya.running()[0];
		assert.equal(atReady?.model, 'claude-opus-5', 'the last assistant record wins at bind');
		assert.equal(atReady?.title, 'first prompt', 'a live session is titled by its first prompt');

		await append(home, reply('<synthetic>', 'API Error'));
		await append(home, reply('claude-fable-5-1'));
		await waitFor(() => aya.running()[0]?.model === 'claude-fable-5-1');
		assert.equal(models.includes('<synthetic>'), false);
		assert.equal(models.at(-1), 'claude-fable-5-1');
	} finally {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test('a journal is read once at bind and an appended record is handled once', async () => {
	const filler = 'x'.repeat(2000);
	const records: unknown[] = [user('start')];
	for (let i = 0; i < 100; i++) records.push(reply('claude-opus-5', filler));
	const { home, procs, bindSession } = await liveHome(records);
	await bindSession();
	const fs = spyFs();
	const aya = AllYourAgents({
		providers: [claudeCode({ home })],
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
		const path = journalPath(home);
		const size = (await stat(path)).size;
		// Finding the journal validates it with one bounded read of its head.
		const validation = 16 * 1024;
		assert.ok(size > 10 * validation, 'large enough that a second full read would show');
		assert.equal(fs.bytesRead.get(path), size + validation);

		const appended = `${JSON.stringify(toolUse('t1'))}\n`;
		await appendFile(path, appended);
		await waitFor(() => tools.length > 0);
		await sleep(50);
		assert.deepEqual(tools, ['t1']);
		assert.equal(fs.bytesRead.get(path), size + validation + appended.length);
	} finally {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test('a record that cannot be handled is reported and the tail keeps running', async () => {
	const { home, procs, bindSession } = await liveHome([user('start')]);
	await bindSession();
	const real = claudeCode({ home });
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
		await append(home, toolUse('bad'));
		await waitFor(() => errors.length === 1);
		await append(home, toolUse('good'));
		await waitFor(() => aya.running()[0]?.activity.tool?.id === 'good');
		const [error] = errors;
		assert.ok(error?.source === 'provider');
		assert.equal(error.provider, 'claude-code');
		assert.equal((error.error as Error).message, 'cannot handle');
		assert.equal(errors.length, 1);
	} finally {
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

/** Holds whichever call the test routes through `hold()` until `release()`. */
function gate() {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const g = {
		held: false,
		hold(): Promise<void> {
			g.held = true;
			return released;
		},
		release,
	};
	return g;
}

test('stop while a session is being bound leaves no watch open', async () => {
	const { home, procs, bindSession } = await liveHome([user('start'), reply('claude-opus-5')]);
	const fs = spyFs();
	const g = gate();
	// Hold the bind where it looks for the journal, before it has attached anything.
	fs.hooks.stat = (path) => (path === journalPath(home) ? g.hold() : undefined);
	const aya = AllYourAgents({
		providers: [claudeCode({ home })],
		processes: procs,
		fs,
		debounce: { quietMs: 10 },
	});
	const seen: Session[] = [];
	aya.on('session:open', (s) => seen.push(s));
	try {
		await aya.start();
		await bindSession();
		await waitFor(() => g.held);
		await aya.stop();
		g.release();
		await sleep(80);
		assert.deepEqual(fs.openWatches(), []);
		assert.deepEqual(seen, []);
	} finally {
		g.release();
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test('a session that closes while its journal backlog is being read attaches nothing', async () => {
	const { home, procs, bindSession } = await liveHome([user('start'), reply('claude-opus-5')]);
	const fs = spyFs();
	const g = gate();
	const readRange = fs.readRange;
	// Validating the journal reads a fixed 16 KiB head; any other read is the tail's backlog.
	fs.readRange = async (path, start, end) => {
		if (path === journalPath(home) && end !== 16 * 1024) await g.hold();
		return readRange(path, start, end);
	};
	const aya = AllYourAgents({
		providers: [claudeCode({ home })],
		processes: procs,
		fs,
		debounce: { quietMs: 10 },
	});
	const closed: string[] = [];
	aya.on('session:close', (s) => closed.push(s.id));
	try {
		await aya.start();
		await bindSession();
		await waitFor(() => g.held);
		// The provider keeps running; only this session goes away.
		procs.set(1, false);
		procs.fire(1);
		assert.deepEqual(closed, [ID]);
		g.release();
		await sleep(80);
		assert.deepEqual(fs.openWatches(), [join(home, 'sessions')]);
	} finally {
		g.release();
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
	assert.deepEqual(fs.openWatches(), []);
});

test('a session file removed while it is being bound does not come back', async () => {
	const { home, procs, bindSession } = await liveHome([user('start'), reply('claude-opus-5')]);
	const fs = spyFs();
	const g = gate();
	fs.hooks.stat = (path) => (path === journalPath(home) ? g.hold() : undefined);
	const aya = AllYourAgents({
		providers: [claudeCode({ home })],
		processes: procs,
		fs,
		debounce: { quietMs: 10 },
	});
	const events: string[] = [];
	aya.on('session:open', () => events.push('open'));
	aya.on('session:close', () => events.push('close'));
	try {
		await aya.start();
		await bindSession();
		await waitFor(() => g.held);
		await unlink(join(home, 'sessions', '1.json'));
		await sleep(80);
		g.release();
		await waitFor(() => events.includes('close'));
		await sleep(80);
		// The removal waited its turn behind the bind, then undid all of it.
		assert.deepEqual(events, ['open', 'close']);
		assert.deepEqual(aya.running(), []);
		assert.deepEqual(fs.openWatches(), [join(home, 'sessions')]);
	} finally {
		g.release();
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});

test('stop during start releases what start went on to open', async () => {
	const { home, procs, bindSession } = await liveHome([user('start'), reply('claude-opus-5')]);
	await bindSession();
	const fs = spyFs();
	const g = gate();
	fs.hooks.stat = (path) => (path === journalPath(home) ? g.hold() : undefined);
	const aya = AllYourAgents({
		providers: [claudeCode({ home })],
		processes: procs,
		fs,
		debounce: { quietMs: 10 },
	});
	try {
		const starting = aya.start();
		await waitFor(() => g.held);
		const stopping = aya.stop();
		g.release();
		await Promise.all([starting, stopping]);
		await sleep(80);
		assert.deepEqual(fs.openWatches(), []);
		assert.deepEqual(aya.running(), []);
	} finally {
		g.release();
		await aya.stop();
		await rm(home, { recursive: true, force: true });
	}
});
