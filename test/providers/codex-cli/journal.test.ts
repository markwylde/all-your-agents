import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { mapRecord, resolveRollout } from '../../../src/providers/codex-cli/journal.js';
import { A, B, responseItem, rolloutPath, sessionMeta, writeRollout } from './home.js';

test('maps response_item and skips reasoning, world_state, item_completed duplicates', () => {
	assert.equal(mapRecord(responseItem({ type: 'reasoning', summary: [] })).length, 0);
	assert.equal(mapRecord({ type: 'world_state', payload: {} }).length, 0);
	const user = mapRecord(
		responseItem({
			type: 'message',
			role: 'user',
			content: [{ type: 'input_text', text: 'hello world' }],
		}),
	);
	assert.equal(user[0]?.kind, 'user');
	const tool = mapRecord(
		responseItem({ type: 'function_call', call_id: 'c1', name: 'exec', arguments: '{}' }),
	);
	assert.equal(tool[0]?.kind, 'tool');
	assert.equal(
		mapRecord({
			type: 'event_msg',
			payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1' } },
		}).length,
		0,
	);
	assert.equal(
		mapRecord({
			type: 'event_msg',
			payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [] } },
		}).length,
		0,
	);
	assert.equal(mapRecord({ type: 'compacted', payload: { replacement: [] } }).length, 0);
	assert.equal(
		mapRecord(responseItem({ type: 'local_shell_call', call_id: 's1', name: 'local_shell' }))[0]
			?.kind,
		'tool',
	);
	assert.equal(
		mapRecord(responseItem({ type: 'custom_tool_call', call_id: 't1', name: 'exec' }))[0]?.kind,
		'tool',
	);
	assert.equal(
		mapRecord(
			responseItem({
				type: 'message',
				role: 'user',
				content: [{ type: 'encrypted_content', text: 'secret' }],
			}),
		).length,
		0,
	);
	assert.equal(
		mapRecord(
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
		).length,
		0,
	);
	const real = mapRecord(
		responseItem({
			type: 'message',
			role: 'user',
			content: [
				{
					type: 'input_text',
					text: '# AGENTS.md instructions for /tmp\n\n<INSTRUCTIONS>\nx\n</INSTRUCTIONS>',
				},
				{ type: 'input_text', text: '## My request for Codex:\nCount to 5' },
			],
		}),
	);
	assert.equal(real[0]?.kind, 'user');
	assert.equal(real[0] && 'text' in real[0] ? real[0].text : '', 'Count to 5');
});

test('two files with the same id: newest plain wins; ambiguous lookup still returns one newest', async () => {
	const home = await mkdtemp(join(tmpdir(), 'aya-codex-j-'));
	try {
		const extra = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
		const a = rolloutPath(home, A);
		const b = rolloutPath(home, A, '2026-01-02T00-00-00', extra);
		await writeRollout(a, [sessionMeta(A)]);
		await writeRollout(b, [sessionMeta(A)]);
		const fs = createLocalFs();
		const path = await resolveRollout(fs, home, A);
		assert.ok(path);
		assert.ok(path.endsWith('.jsonl'));
		const other = rolloutPath(home, B);
		await writeRollout(other, [sessionMeta(B)]);
		assert.equal(await resolveRollout(fs, home, B), other);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
