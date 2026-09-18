import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AllYourAgents } from '../../../src/index.js';
import { codexCli } from '../../../src/providers/codex-cli/index.js';
import { spyFs } from '../../util/spy-fs.js';
import { waitFor } from '../../util/wait.js';
import { A, B, eventMsg, responseItem, rolloutPath, sessionMeta, writeRollout } from './home.js';

test('list skips subagents, uses index title, headless exec, zst-only without opening', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-list-'));
	try {
		await writeRollout(rolloutPath(home, A), [
			sessionMeta(A),
			eventMsg('thread_settings_applied', { thread_settings: { model: 'gpt-5.6-luna' } }),
			responseItem({
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'prompt title' }],
			}),
		]);
		await writeRollout(rolloutPath(home, B), [
			sessionMeta(B, {
				parent_thread_id: A,
				thread_source: 'subagent',
				source: { subagent: {} },
			}),
		]);
		const execId = '00000000-0000-4000-8000-0000000000ee';
		await writeRollout(rolloutPath(home, execId), [sessionMeta(execId, { source: 'exec' })]);
		const zstId = '00000000-0000-4000-8000-0000000000cc';
		const zst = `${rolloutPath(home, zstId)}.zst`;
		await writeFile(zst, 'not-json');
		await writeFile(
			join(home, 'session_index.jsonl'),
			`${JSON.stringify({ id: A, thread_name: 'Harness title', updated_at: new Date().toISOString() })}\n${JSON.stringify({ id: zstId, thread_name: 'Compressed', updated_at: new Date().toISOString() })}\n`,
		);
		const aya = AllYourAgents({ providers: [codexCli({ home })] });
		const listed = await aya.sessions();
		assert.equal(
			listed.some((s) => s.id === B),
			false,
		);
		const root = listed.find((s) => s.id === A);
		assert.equal(root?.title, 'Harness title');
		assert.equal(root?.model, 'gpt-5.6-luna');
		assert.equal(listed.find((s) => s.id === execId)?.kind, 'headless');
		assert.equal(listed.find((s) => s.id === zstId)?.title, 'Compressed');
		const zstChild = '00000000-0000-4000-8000-0000000000cd';
		await writeFile(`${rolloutPath(home, zstChild)}.zst`, 'not-json');
		const listed2 = await aya.sessions();
		assert.equal(
			listed2.some((s) => s.id === zstChild),
			false,
		);
		const turns: unknown[] = [];
		for await (const turn of (await aya.get(A))?.transcript() ?? []) turns.push(turn);
		assert.ok(turns.length >= 1);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('list title skips AGENTS.md wrappers for the real prompt', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-agents-'));
	try {
		await writeRollout(rolloutPath(home, A), [
			sessionMeta(A),
			responseItem({
				type: 'message',
				role: 'user',
				content: [
					{
						type: 'input_text',
						text: '# AGENTS.md instructions for /tmp/app\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>',
					},
					{
						type: 'input_text',
						text: '<environment_context>\n  <cwd>/tmp/app</cwd>\n</environment_context>',
					},
				],
			}),
			responseItem({
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'real prompt please' }],
			}),
		]);
		const aya = AllYourAgents({ providers: [codexCli({ home })] });
		const listed = await aya.sessions();
		assert.equal(listed.find((s) => s.id === A)?.title, 'real prompt please');
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('index title does not parse a large rollout', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-ins-'));
	try {
		const path = rolloutPath(home, A);
		await writeRollout(path, [sessionMeta(A)]);
		await appendFile(path, `${'x'.repeat(2_000_000)}\n`);
		await writeFile(
			join(home, 'session_index.jsonl'),
			`${JSON.stringify({ id: A, thread_name: 'From index', updated_at: new Date().toISOString() })}\n`,
		);
		const fs = spyFs();
		const aya = AllYourAgents({ providers: [codexCli({ home })], fs });
		const listed = await aya.sessions();
		assert.equal(listed.find((s) => s.id === A)?.title, 'From index');
		const read = fs.bytesRead.get(path) ?? 0;
		assert.ok(read < 2_000_000, `read ${read}`);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('events() tails appends and close() releases the watch', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-ev-'));
	try {
		const path = rolloutPath(home, A);
		await writeRollout(path, [
			sessionMeta(A),
			responseItem({
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'one' }],
			}),
		]);
		const fs = spyFs();
		const aya = AllYourAgents({ providers: [codexCli({ home })], fs });
		const session = await aya.get(A);
		assert.ok(session);
		const stream = session.events();
		try {
			const iter = stream[Symbol.asyncIterator]();
			let first = await iter.next();
			while (!first.done && (first.value as { kind: string }).kind !== 'user') {
				first = await iter.next();
			}
			assert.equal((first.value as { kind: string }).kind, 'user');
			const pending = iter.next();
			await appendFile(
				path,
				`${JSON.stringify(responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two' }] }))}\n`,
			);
			const second = await pending;
			assert.equal((second.value as { text?: string }).text, 'two');
		} finally {
			stream.close();
		}
		await waitFor(() => !fs.openWatches().some((p) => p.endsWith('.jsonl')) || undefined);
		await aya.stop();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
