import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalFs } from '../../../src/helpers/fs.js';
import { turnFactsFromRecord } from '../../../src/providers/claude-code/activity.js';
import {
	mapRecord,
	modelOf,
	promptTitle,
	resolveJournal,
} from '../../../src/providers/claude-code/journal.js';

test('mapper tables', () => {
	assert.equal(mapRecord({ type: 'user', message: { content: '<system-reminder>x' } }).length, 0);
	assert.equal(
		mapRecord({
			type: 'user',
			origin: { kind: 'task-notification' },
			message: { content: '<task-notification>' },
		}).length,
		0,
	);
	assert.equal(mapRecord({ type: 'queue-operation', content: '<task-notification>' }).length, 0);
	assert.equal(mapRecord({ type: 'custom-title', customTitle: 'iosbugs' })[0]?.kind, 'title');
	assert.equal(mapRecord({ type: 'ai-title', aiTitle: 'hi' })[0]?.kind, 'title');
	assert.equal(mapRecord({ type: 'system', subtype: 'turn_duration' })[0]?.kind, 'turn-end');
	assert.equal(mapRecord({ type: 'relocated' }).length, 0);
	assert.equal(mapRecord({ type: 'worktree-state' }).length, 0);
	assert.equal(mapRecord({ type: 'bridge-session' }).length, 0);
	assert.equal(mapRecord({ type: 'file-history-delta' }).length, 0);
	assert.equal(mapRecord({ type: 'system', subtype: 'compact_boundary' }).length, 0);
	assert.equal(mapRecord({ type: 'system', subtype: 'stop_hook_summary' }).length, 0);
	assert.equal(mapRecord({ type: 'unknown-future' }).length, 0);
	assert.equal(
		mapRecord({ type: 'user', message: { content: [{ type: 'text', text: '<command-name>x' }] } })
			.length,
		0,
	);
	const user = mapRecord({ type: 'user', message: { content: 'hello' } });
	assert.equal(user[0]?.kind, 'user');
});

test('shell-mode records are not prompts', () => {
	for (const content of ['<bash-input>ls</bash-input>', '<bash-stdout>a\nb</bash-stdout>']) {
		assert.deepEqual(mapRecord({ type: 'user', message: { content } }), []);
		assert.deepEqual(turnFactsFromRecord({ type: 'user', message: { content } }), []);
	}
});

test('a slash command that runs a turn is a prompt, titled as it was typed', () => {
	const content =
		'<command-message>opsx:propose</command-message>\n<command-name>/opsx:propose</command-name>\n<command-args>add a  history view</command-args>';
	assert.equal(mapRecord({ type: 'user', message: { content } })[0]?.kind, 'user');
	assert.deepEqual(turnFactsFromRecord({ type: 'user', message: { content } }), [
		{ type: 'turn-started', at: undefined },
	]);
	assert.equal(promptTitle(content), '/opsx:propose add a  history view');
	assert.equal(
		promptTitle('<command-message>init</command-message>\n<command-name>/init</command-name>'),
		'/init',
	);
	assert.equal(promptTitle('x'.repeat(500)).length, 200);
	assert.equal(promptTitle('plain prompt'), 'plain prompt');
});

test('modelOf reads assistant records only and ignores the synthetic placeholder', () => {
	assert.equal(
		modelOf({ type: 'assistant', message: { model: 'claude-opus-5' } }),
		'claude-opus-5',
	);
	assert.equal(modelOf({ type: 'assistant', message: { model: '<synthetic>' } }), undefined);
	assert.equal(modelOf({ type: 'user', message: { model: 'claude-opus-5' } }), undefined);
	assert.equal(modelOf({ type: 'assistant' }), undefined);
	assert.equal(modelOf(null), undefined);
});

test('journal resolution: derived, lookup, ambiguity, sidechain', async () => {
	const root = await mkdtemp(join(tmpdir(), 'aya-j-'));
	const fs = createLocalFs();
	const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
	try {
		const a = join(root, 'projects', '-a');
		const b = join(root, 'projects', '-b');
		await mkdir(a, { recursive: true });
		await writeFile(join(a, `${id}.jsonl`), `${JSON.stringify({ sessionId: id, cwd: '/a' })}\n`);
		assert.equal(await resolveJournal(fs, root, id, '/a'), join(a, `${id}.jsonl`));
		assert.equal(await resolveJournal(fs, root, id, '/b'), join(a, `${id}.jsonl`));
		await mkdir(b, { recursive: true });
		await writeFile(join(b, `${id}.jsonl`), `${JSON.stringify({ sessionId: id, cwd: '/b' })}\n`);
		assert.equal(await resolveJournal(fs, root, id, '/z'), undefined);
		const side = join(root, 'projects', '-s');
		await mkdir(side, { recursive: true });
		const sid = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
		await writeFile(
			join(side, `${sid}.jsonl`),
			`${JSON.stringify({ sessionId: sid, isSidechain: true })}\n`,
		);
		assert.equal(await resolveJournal(fs, root, sid), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
