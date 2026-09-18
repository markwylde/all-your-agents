import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { grokBuild } from '../../../src/providers/grok-build/index.js';
import type { SessionEvent } from '../../../src/types.js';
import { spyFs } from '../../util/spy-fs.js';
import { waitFor } from '../../util/wait.js';
import { fakeProcesses, makeSession, user, writeMeta } from './home.js';

const A = '01a0b474-0a8c-7002-b1fd-ff90b332cdc3';
const B = '01a0b474-0a8c-7002-b1fd-ff90b332cdc4';
const C = '01a0b474-0a8c-7002-b1fd-ff90b332cdc5';
const H = '01a0b474-0a8c-7002-b1fd-ff90b332cdc6';
const SUB = '01a0b474-0a8c-7002-b1fd-ff90b332cd01';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	try {
		await fn(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

const offline = (home: string, fs = spyFs()) =>
	AllYourAgents({ providers: [grokBuild({ home })], processes: fakeProcesses(), fs });

test('history: titles by precedence, model, kind, and subagents excluded', async () => {
	await withHome(async (home) => {
		const created = '2026-09-18T10:00:00.000000Z';
		const bigChat = [
			user('the first prompt', 0),
			...Array.from({ length: 3000 }, () => ({ type: 'assistant', content: 'x'.repeat(100) })),
		];
		const aDir = await makeSession(home, '/app', A, {
			summary: {
				generated_title: 'Mine',
				title_is_manual: true,
				created_at: created,
				last_active_at: '2026-09-18T11:00:00Z',
				current_model_id: 'grok-4.6',
			},
			chat: bigChat,
		});
		await makeSession(home, '/app', B, {
			summary: { generated_title: 'Generated' },
			chat: [user('ignored', 0)],
		});
		await makeSession(home, '/app', C, { summary: {}, chat: [user('from the prompt', 0)] });
		await makeSession(home, '/tmp/print', H, { summary: { session_kind: 'headless' } });
		await writeMeta(aDir, { subagent_id: SUB, parent_session_id: A, status: 'completed' });
		await makeSession(home, '/app/.grok/worktrees/sub', SUB, {
			summary: { session_kind: 'subagent', generated_title: 'Child' },
		});
		const fs = spyFs();
		const aya = offline(home, fs);
		const all = await aya.sessions();
		const byId = new Map(all.map((s) => [s.id, s]));
		assert.equal(byId.has(SUB), false);
		const a = byId.get(A);
		assert.equal(a?.title, 'Mine');
		assert.equal(a?.model, 'grok-4.6');
		assert.equal(a?.cwd, '/app');
		assert.equal(a?.startedAt, Date.parse(created));
		assert.equal(a?.updatedAt, Date.parse('2026-09-18T11:00:00Z'));
		assert.equal(a?.kind, 'interactive');
		assert.equal(byId.get(B)?.title, 'Generated');
		assert.equal(byId.get(C)?.title, 'from the prompt');
		assert.equal(byId.get(H)?.kind, 'headless');
		assert.equal(
			fs.bytesRead.get(join(aDir, 'chat_history.jsonl')),
			undefined,
			'titled by summary',
		);
		assert.equal((await aya.get(C))?.title, 'from the prompt');
	});
});

test('since short-circuits on the summary mtime; print-mode runs are history only', async () => {
	await withHome(async (home) => {
		const old = await makeSession(home, '/app', A, {
			summary: { updated_at: '2020-01-01T00:00:00Z' },
		});
		const past = new Date('2020-01-01T00:00:00Z');
		await utimes(join(old, 'summary.json'), past, past);
		await makeSession(home, '/tmp/print', H, {
			summary: { session_kind: 'headless', updated_at: new Date().toISOString() },
			chat: [user('print this', 0)],
		});
		const fs = spyFs();
		const aya = offline(home, fs);
		const since = Date.now() - 3600_000;
		const recent = await aya.sessions({ since, kind: 'headless' });
		assert.deepEqual(
			recent.map((s) => s.id),
			[H],
		);
		assert.equal(fs.bytesRead.get(join(old, 'summary.json')), undefined);
		await aya.start();
		assert.deepEqual(aya.running(), []);
		await aya.stop();
	});
});

test('inspect: transcript, following appends, release on break and close', async () => {
	await withHome(async (home) => {
		const dir = await makeSession(home, '/app', A, {
			summary: {},
			chat: [user('first', 0), { type: 'assistant', content: 'hello', model_id: 'grok-4.6' }],
		});
		const fs = spyFs();
		const aya = offline(home, fs);
		const session = await aya.get(A);
		assert.ok(session);
		const turns = [];
		for await (const t of session.transcript()) turns.push(t);
		assert.deepEqual(
			turns[0]?.events.map((e) => e.kind),
			['user', 'assistant'],
		);
		const stream = session.events();
		const seen: SessionEvent[] = [];
		const done = (async () => {
			for await (const e of stream) {
				seen.push(e);
				if (e.kind === 'user' && e.text === 'second') break;
			}
		})();
		await waitFor(() => seen.length >= 2);
		await appendFile(join(dir, 'chat_history.jsonl'), `${JSON.stringify(user('second', 1))}\n`);
		await done;
		assert.deepEqual(fs.openWatches(), []);
		const again = session.events();
		const pending = (async () => {
			for await (const _ of again) {
			}
		})();
		await waitFor(() => fs.openWatches().length > 0);
		again.close();
		await pending;
		assert.deepEqual(fs.openWatches(), []);
	});
});

test("a closed session's subagents all have final statuses", async () => {
	await withHome(async (home) => {
		const dir = await makeSession(home, '/app', A, { summary: {} });
		await writeMeta(dir, {
			subagent_id: SUB,
			parent_session_id: A,
			status: 'running',
			description: 'x',
		});
		await writeMeta(
			dir,
			{
				subagent_id: `${SUB.slice(0, -1)}2`,
				parent_session_id: A,
				status: 'running',
			},
			{ output: 'done' },
		);
		const aya = offline(home);
		const subs = (await (await aya.get(A))?.subagents()) ?? [];
		assert.deepEqual(subs.map((s) => s.status).sort(), ['cancelled', 'completed']);
	});
});
