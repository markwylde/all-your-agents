import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { claudeCode } from '../../../src/providers/claude-code/index.js';
import { encodeProjectDir } from '../../../src/providers/claude-code/paths.js';
import { waitFor } from '../../util/wait.js';

const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('list excludes subagent journals and prefers custom-title', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-list-'));
	try {
		const dir = join(home, 'projects', encodeProjectDir('/tmp/app'));
		await mkdir(join(dir, ID, 'subagents'), { recursive: true });
		await writeFile(
			join(dir, `${ID}.jsonl`),
			`${JSON.stringify({ type: 'user', sessionId: ID, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/app', message: { content: 'prompt' } })}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'gen', sessionId: ID })}\n${JSON.stringify({ type: 'custom-title', customTitle: 'mine', sessionId: ID })}\n`,
		);
		await writeFile(join(dir, ID, 'subagents', 'agent-x.jsonl'), '{}\n');
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: { info: async () => ({ alive: false }), watch: () => 'unsupported' },
		});
		const listed = await aya.sessions();
		assert.equal(listed.length, 1);
		assert.equal(listed[0]?.id, ID);
		assert.equal(listed[0]?.title, 'mine');
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('list takes model from the last assistant record that names a real one', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-list-'));
	try {
		const dir = join(home, 'projects', encodeProjectDir('/tmp/app'));
		await mkdir(dir, { recursive: true });
		const assistant = (model: string) => ({
			type: 'assistant',
			sessionId: ID,
			message: { model, content: [{ type: 'text', text: 'ok' }] },
		});
		const records = [
			{ type: 'user', sessionId: ID, cwd: '/tmp/app', message: { content: 'prompt' } },
			assistant('claude-sonnet-5'),
			assistant('claude-opus-5'),
			assistant('<synthetic>'),
		];
		await writeFile(
			join(dir, `${ID}.jsonl`),
			`${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
		);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: { info: async () => ({ alive: false }), watch: () => 'unsupported' },
		});
		assert.equal((await aya.sessions())[0]?.model, 'claude-opus-5');
		assert.equal((await aya.get(ID))?.model, 'claude-opus-5');
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('events() tails appends and break closes the watch', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-ins-'));
	try {
		const dir = join(home, 'projects', encodeProjectDir('/tmp/app'));
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${ID}.jsonl`);
		await writeFile(
			path,
			`${JSON.stringify({ type: 'user', sessionId: ID, message: { content: 'one' } })}\n`,
		);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: { info: async () => ({ alive: false }), watch: () => 'unsupported' },
		});
		const session = await aya.get(ID);
		assert.ok(session);
		const iter = session.events()[Symbol.asyncIterator]();
		const first = await iter.next();
		assert.equal((first.value as { kind: string }).kind, 'user');
		const pending = iter.next();
		await appendFile(
			path,
			`${JSON.stringify({ type: 'user', sessionId: ID, message: { content: 'two' } })}\n`,
		);
		const second = await pending;
		assert.equal((second.value as { text?: string }).text, 'two');
		await iter.return?.();
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('worktree move emits update only and does not close', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-rel-'));
	const start = Date.now() - 200;
	const pid = 42;
	try {
		await mkdir(join(home, 'sessions'), { recursive: true });
		await mkdir(join(home, 'projects', encodeProjectDir('/tmp/app')), { recursive: true });
		await writeFile(
			join(home, 'projects', encodeProjectDir('/tmp/app'), `${ID}.jsonl`),
			`${JSON.stringify({ type: 'user', sessionId: ID, cwd: '/tmp/app', message: { content: 'hi' } })}\n`,
		);
		await writeFile(
			join(home, 'sessions', `${pid}.json`),
			JSON.stringify({
				pid,
				sessionId: ID,
				cwd: '/tmp/app',
				startedAt: start,
				status: 'busy',
			}),
		);
		const aya = AllYourAgents({
			providers: [claudeCode({ home })],
			processes: {
				info: async () => ({ alive: true, startTime: start }),
				watch: () => ({ stop() {} }),
			},
			debounce: { quietMs: 10 },
		});
		const events: string[] = [];
		aya.on('session:close', () => events.push('close'));
		aya.on('session:update', (s) => events.push(`update:${s.cwd}`));
		aya.on('subagent:start', () => events.push('sub'));
		await aya.start();
		const next = '/tmp/app/.claude/worktrees/x';
		await mkdir(join(home, 'projects', encodeProjectDir(next)), { recursive: true });
		await writeFile(
			join(home, 'projects', encodeProjectDir(next), `${ID}.jsonl`),
			`${JSON.stringify({ type: 'user', sessionId: ID, cwd: next, message: { content: 'hi' } })}\n`,
		);
		await writeFile(
			join(home, 'sessions', `${pid}.json`),
			JSON.stringify({
				pid,
				sessionId: ID,
				cwd: next,
				startedAt: start,
				status: 'busy',
			}),
		);
		await waitFor(() => events.some((e) => e.startsWith('update:')));
		assert.equal(events.includes('close'), false);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
