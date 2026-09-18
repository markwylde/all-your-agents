import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import {
	cwdOfDir,
	mapChatRecord,
	resolveSessionDir,
} from '../../../src/providers/grok-build/journal.js';
import { makeSession, sessionDir, user } from './home.js';

const ID = '01a0b474-0a8c-7002-b1fd-ff90b332cdc3';

test('session dir: derived, resumed from another dir, ambiguous', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	const fs = createLocalFs();
	try {
		await makeSession(home, '/tmp/app', ID);
		assert.equal(
			await resolveSessionDir(fs, home, ID, '/tmp/app'),
			sessionDir(home, '/tmp/app', ID),
		);
		assert.equal(
			await resolveSessionDir(fs, home, ID, '/elsewhere'),
			sessionDir(home, '/tmp/app', ID),
			'found by the one-level lookup',
		);
		assert.equal(await resolveSessionDir(fs, home, ID), sessionDir(home, '/tmp/app', ID));
		await makeSession(home, '/tmp/other', ID);
		assert.equal(await resolveSessionDir(fs, home, ID, '/elsewhere'), undefined, 'two hits');
		assert.equal(await resolveSessionDir(fs, join(home, 'missing'), ID), undefined);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('a long cwd is found by lookup and recovered from .cwd', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-grok-'));
	const fs = createLocalFs();
	const cwd = `/${'deep/'.repeat(60)}app`;
	try {
		const hashed = join(home, 'sessions', 'deep-deep-app-0123456789abcdef');
		await mkdir(join(hashed, ID), { recursive: true });
		await writeFile(join(hashed, '.cwd'), cwd);
		assert.equal(await resolveSessionDir(fs, home, ID, cwd), join(hashed, ID));
		assert.equal(await cwdOfDir(fs, hashed, 'deep-deep-app-0123456789abcdef'), cwd);
		assert.equal(await cwdOfDir(fs, '/nowhere', '%2Ftmp%2Ffoo%28bar%29%21'), '/tmp/foo(bar)!');
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('chat history mapping', () => {
	const kinds = (records: unknown[]) => {
		const state = {};
		return records
			.flatMap((r) => mapChatRecord(r, state))
			.map((e) => {
				const { raw: _raw, ...rest } = e as { raw: unknown };
				return rest;
			});
	};
	assert.deepEqual(
		kinds([
			{ type: 'system', content: 'You are Grok' },
			{ type: 'user', content: [{ type: 'text', text: '<user_info>\nOS\n</user_info>' }] },
			{
				type: 'user',
				synthetic_reason: 'system_reminder',
				content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }],
			},
			{
				type: 'user',
				prompt_index: 5,
				content: [{ type: 'text', text: '<system-reminder>only a reminder</system-reminder>' }],
			},
			user('fix the bug', 0),
			user('fix the bug', 0),
			{ type: 'reasoning', id: 'rs_1', summary: [] },
			{
				type: 'assistant',
				content: 'Looking.',
				model_id: 'grok-4.6-build',
				tool_calls: [
					{ id: 'c1', name: 'read_file', arguments: '{}' },
					{
						id: 'c2',
						name: 'spawn_subagent',
						arguments: JSON.stringify({
							description: 'Explore',
							subagent_type: 'general-purpose',
							background: true,
						}),
					},
				],
			},
			{ type: 'tool_result', tool_call_id: 'c1', content: 'file' },
			{
				type: 'tool_result',
				tool_call_id: 'c2',
				content: 'done\n\n<subagent_result>\nsubagent_id: s1\n</subagent_result>',
			},
			{ type: 'assistant', error: 'rate limited' },
			{ type: 'backend_tool_call', kind: {} },
			{ type: 'tool_definitions' },
			{ type: 'something_new' },
		]),
		[
			{ kind: 'user', text: 'fix the bug' },
			{ kind: 'assistant', text: 'Looking.', model: 'grok-4.6-build' },
			{ kind: 'tool', id: 'c1', name: 'read_file' },
			{ kind: 'tool', id: 'c2', name: 'spawn_subagent' },
			{
				kind: 'subagent',
				id: 'c2',
				title: 'Explore',
				type: 'general-purpose',
				background: true,
			},
			{ kind: 'tool-result', id: 'c1', isError: false },
			{ kind: 'tool-result', id: 'c2', isError: false },
			{ kind: 'subagent-end', id: 'c2', status: 'completed' },
			{ kind: 'error', message: 'rate limited' },
		],
	);
});
